/**
 * Concurrency-one campaign runner over a list of schedule slots (one scored block, or the pilots).
 * The records directory is the checkpoint: rerunning the same command after any interruption skips
 * finished slots, closes an attempt the runner died in as operational (`runner-interrupted`),
 * finishes a pending evaluation of an already frozen snapshot, and otherwise starts the next
 * attempt. Nothing is ever overwritten; every attempt keeps its own directory.
 *
 * Retry policy (methodology section 8): scored failures are never retried. An operational attempt
 * gets at most `maxReplacements` linked replacements, each in a fresh workspace. Quota exhaustion,
 * missing authentication and model substitution pause the campaign (the process exits); the next
 * invocation, after the allowance or access is restored, starts the linked replacement and records
 * the wait. Provider outages and runner or evaluator infrastructure failures wait a fixed backoff in
 * process first. When replacements are exhausted the campaign pauses and the block stays incomplete.
 *
 * Pilot retry (pilots only, opt-in through `pilotRetry`): a pilot exists to exercise its whole
 * workflow, so an early finished failure covers its configuration without exercising it. When
 * `pilotRetry.unexercised` says no finished attempt of a pilot slot exercised the workflow, the
 * runner starts one fresh attempt per invocation (`pilotRetryOf` links it; earlier attempts are kept
 * untouched). Scored blocks ignore this option, so a scored failure is never retried.
 *
 * Quota audit (scored blocks, methodology section 8): `effectiveRecord` overlays the block's audit
 * decisions on each saved record. An attempt reclassified as `quota-exhausted` is then operational,
 * so its slot is refilled under the ordinary replacement rules: a fresh workspace, a `replaces`
 * link, and the same budget (the reclassified attempt counts as one of the operational attempts).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Supervised } from '../evaluator/supervise.ts';
import type { ScheduleSlot } from './schedule.ts';
import {
  ATTEMPT_SCHEMA,
  appendJsonl,
  attemptFile,
  classify,
  listAttemptDirs,
  readJson,
  writeJsonAtomic,
  type AttemptRecord,
  type WorkflowTermination,
} from './state.ts';
import type { WorkflowOutcome } from './workflow.ts';

export const PAUSING_TERMINATIONS: ReadonlySet<string> = new Set(['quota-exhausted', 'auth-missing', 'model-substituted']);

export interface CampaignConfig {
  label: string;
  slots: ScheduleSlot[];
  maxReplacements: number;
  /** Committed records for this campaign label (for example records/cohort-03). */
  recordsRoot: string;
  /** Gitignored runtime root (workspaces, tool homes, snapshots). */
  runtimeRoot: string;
  outageBackoffMs: number;
  /** Pilots only: decides whether a finished, non-operational pilot left its configuration unexercised. */
  pilotRetry?: { unexercised(rec: AttemptRecord, attemptDir: string): boolean };
  /** The record as the retry policy must treat it (quota audit overlay). Never written back. */
  effectiveRecord?: (rec: AttemptRecord) => AttemptRecord;
}

export interface AttemptContext {
  slot: ScheduleSlot;
  attempt: number;
  attemptKey: string;
  recordsDir: string;
  runtimeDir: string;
}

export interface CampaignDeps {
  now(): number;
  wallClock(): Date;
  sleep(ms: number): Promise<void>;
  /** Creates the fresh workspace and runs the workflow; must not throw (failures become outcomes). */
  runAttempt(ctx: AttemptContext): Promise<WorkflowOutcome>;
  /** Freezes the final workspace into `dest` and returns its content hash. */
  freeze(workspace: string, dest: string): string;
  evaluate(o: { snapshotDir: string; workDir: string; verdictPath: string }): Promise<Supervised>;
  copyFile(from: string, to: string): void;
  /** Operating-environment facts recorded on each new attempt (methodology section 10). */
  environment?(): unknown;
}

export type CampaignResult =
  | { status: 'complete'; slots: number }
  | { status: 'paused'; reason: string; slot: ScheduleSlot; attempt: number | null };

const pad = (n: number) => String(n).padStart(2, '0');
export const blockDirName = (block: number) => (block === 0 ? 'pilot' : `block-${pad(block)}`);
export const slotDirName = (s: ScheduleSlot) => `slot-${pad(s.slot)}-${s.conditionId}`;
export const attemptKey = (label: string, s: ScheduleSlot, attempt: number) => `${label}-b${pad(s.block)}-s${pad(s.slot)}-a${attempt}`;

type Step = { kind: 'done' } | { kind: 'again' } | { kind: 'pause'; reason: string; attempt: number | null };

export async function runCampaign(cfg: CampaignConfig, deps: CampaignDeps): Promise<CampaignResult> {
  const endedThisRun = new Set<string>();
  const log = (type: string, fields: Record<string, unknown>) => appendJsonl(join(cfg.recordsRoot, 'campaign-log.jsonl'), { at: deps.wallClock().toISOString(), type, ...fields });
  const release = acquireLock(join(cfg.runtimeRoot, 'campaign.lock'), log);
  try {
    log('campaign-started', { slots: cfg.slots.length });
    for (const slot of cfg.slots) {
      for (;;) {
        const step = await advanceSlot(cfg, deps, slot, endedThisRun, log);
        if (step.kind === 'done') break;
        if (step.kind === 'pause') {
          log('campaign-paused', { block: slot.block, slot: slot.slot, conditionId: slot.conditionId, reason: step.reason, attempt: step.attempt });
          return { status: 'paused', reason: step.reason, slot, attempt: step.attempt };
        }
      }
    }
    log('campaign-complete', { slots: cfg.slots.length });
    return { status: 'complete', slots: cfg.slots.length };
  } finally {
    release();
  }
}

export function slotDir(cfg: Pick<CampaignConfig, 'recordsRoot'>, slot: ScheduleSlot): string {
  return join(cfg.recordsRoot, blockDirName(slot.block), slotDirName(slot));
}

async function advanceSlot(cfg: CampaignConfig, deps: CampaignDeps, slot: ScheduleSlot, endedThisRun: Set<string>, log: (t: string, f: Record<string, unknown>) => void): Promise<Step> {
  const sDir = slotDir(cfg, slot);
  const effective = (r: AttemptRecord | null) => (r && cfg.effectiveRecord ? cfg.effectiveRecord(r) : r);
  const attempts = listAttemptDirs(sDir).map((a) => ({ ...a, rec: effective(readJson<AttemptRecord>(attemptFile(a.dir))) }));
  const finished = attempts.filter((a) => a.rec?.phase === 'finished' && a.rec.outcome !== 'operational');
  const last = attempts.at(-1);
  let pilotRetryOf: number | null = null;
  if (finished.length > 0) {
    if (!cfg.pilotRetry || slot.block !== 0) return { kind: 'done' };
    if (finished.some((a) => !cfg.pilotRetry!.unexercised(a.rec!, a.dir))) return { kind: 'done' };
    // At most one fresh retry per slot per invocation, so a pilot that keeps failing early cannot loop.
    if (finished.some((a) => endedThisRun.has(`${slot.block}/${slot.slot}/${a.attempt}`))) return { kind: 'done' };
    if (last?.rec?.phase === 'finished' && last.rec.outcome !== 'operational') pilotRetryOf = last.attempt;
  }

  if (last && (!last.rec || last.rec.phase === 'running')) {
    // The runner stopped while this attempt was executing: its outcome is unknown, so it is
    // operational and replaced from a fresh workspace. Its records and usage stay as they are.
    const rec: AttemptRecord = last.rec ?? blankRecord(cfg, slot, last.attempt, null, deps.wallClock().toISOString(), 0, null);
    writeJsonAtomic(attemptFile(last.dir), { ...rec, phase: 'finished', termination: 'runner-infrastructure-failure', terminationDetail: 'runner-interrupted', outcome: 'operational', accepted: null, endedAt: rec.endedAt, interruptionDetectedAt: deps.wallClock().toISOString() });
    log('attempt-interrupted', { slot: slot.slot, attempt: last.attempt });
    return { kind: 'again' };
  }

  if (last?.rec?.phase === 'awaiting-evaluation') {
    await evaluateAttempt(cfg, deps, slot, last.dir, last.rec, log);
    return { kind: 'again' };
  }

  // Replacement budget counts operational attempts since the last finished one (a pilot retry starts afresh).
  const lastFinished = finished.at(-1)?.attempt ?? 0;
  const operational = attempts.filter((a) => a.attempt > lastFinished && a.rec?.outcome === 'operational');
  if (operational.length > cfg.maxReplacements) return { kind: 'pause', reason: 'replacements-exhausted', attempt: last?.attempt ?? null };

  let waitBeforeMs = 0;
  let waitReason: string | null = null;
  if (pilotRetryOf !== null && last?.rec) {
    const endedAt = last.rec.endedAt ? Date.parse(last.rec.endedAt) : NaN;
    waitBeforeMs = Number.isFinite(endedAt) ? Math.max(0, deps.wallClock().getTime() - endedAt) : 0;
    waitReason = 'pilot-retry-unexercised';
  } else if (last?.rec) {
    const term = last.rec.termination ?? 'unknown';
    const key = `${slot.block}/${slot.slot}/${last.attempt}`;
    if (endedThisRun.has(key)) {
      if (PAUSING_TERMINATIONS.has(term)) return { kind: 'pause', reason: term, attempt: last.attempt };
      if (last.rec.terminationDetail !== 'runner-interrupted') {
        log('backoff', { slot: slot.slot, attempt: last.attempt, termination: term, ms: cfg.outageBackoffMs });
        await deps.sleep(cfg.outageBackoffMs);
      }
    }
    const endedAt = last.rec.endedAt ? Date.parse(last.rec.endedAt) : NaN;
    waitBeforeMs = Number.isFinite(endedAt) ? Math.max(0, deps.wallClock().getTime() - endedAt) : 0;
    waitReason = last.rec.terminationDetail === 'runner-interrupted' ? 'runner-interrupted' : term;
  }

  const n = (last?.attempt ?? 0) + 1;
  const dir = join(sDir, `attempt-${n}`);
  const runtimeDir = join(cfg.runtimeRoot, blockDirName(slot.block), slotDirName(slot), `attempt-${n}`);
  if (existsSync(runtimeDir)) rmSyncGuard(runtimeDir, cfg.runtimeRoot);
  const startedAt = deps.wallClock().toISOString();
  const base = blankRecord(cfg, slot, n, pilotRetryOf === null ? (last?.attempt ?? null) : null, startedAt, waitBeforeMs, waitReason);
  if (pilotRetryOf !== null) base.pilotRetryOf = pilotRetryOf;
  if (deps.environment) base.environment = deps.environment();
  writeJsonAtomic(attemptFile(dir), base);
  log('attempt-started', { slot: slot.slot, conditionId: slot.conditionId, attempt: n, replaces: base.replaces, ...(pilotRetryOf !== null ? { pilotRetryOf } : {}), waitBeforeMs, waitReason });

  const out = await deps.runAttempt({ slot, attempt: n, attemptKey: attemptKey(cfg.label, slot, n), recordsDir: dir, runtimeDir });
  const outcome = classify(out.termination);
  const rec: AttemptRecord = {
    ...base,
    startedAt: out.startedAt,
    endedAt: out.endedAt,
    activeMs: out.activeMs,
    termination: out.termination,
    terminationDetail: out.detail,
    sensorRepairs: out.sensorRepairs,
    stages: out.stages,
    outcome: outcome === 'operational' ? 'operational' : null,
    phase: outcome === 'operational' ? 'finished' : 'awaiting-evaluation',
  };
  if (outcome !== 'operational') {
    if (out.finalWorkspace) {
      try {
        rec.finalSnapshotHash = deps.freeze(out.finalWorkspace, join(runtimeDir, 'final'));
      } catch (e) {
        rec.phase = 'finished';
        rec.outcome = 'operational';
        rec.termination = 'runner-infrastructure-failure';
        rec.terminationDetail = `cannot freeze final snapshot: ${(e as Error).message}`;
      }
    }
  }
  writeJsonAtomic(attemptFile(dir), rec);
  endedThisRun.add(`${slot.block}/${slot.slot}/${n}`);
  log('attempt-ended', { slot: slot.slot, attempt: n, termination: rec.termination, phase: rec.phase });
  return { kind: 'again' };
}

async function evaluateAttempt(cfg: CampaignConfig, deps: CampaignDeps, slot: ScheduleSlot, dir: string, rec: AttemptRecord, log: (t: string, f: Record<string, unknown>) => void): Promise<void> {
  const runtimeDir = join(cfg.runtimeRoot, blockDirName(slot.block), slotDirName(slot), `attempt-${rec.attempt}`);
  const snapshotDir = join(runtimeDir, 'final');
  const completed = rec.termination === 'completed';
  if (rec.finalSnapshotHash === null || !existsSync(snapshotDir)) {
    // No implementation exists (for example a failed plan handoff): a rejection, not an evaluation.
    const reason = rec.finalSnapshotHash === null ? 'no implementation snapshot' : 'frozen snapshot missing';
    if (completed) {
      writeJsonAtomic(attemptFile(dir), { ...rec, phase: 'finished', outcome: 'operational', termination: 'runner-infrastructure-failure', terminationDetail: reason, accepted: null });
      return;
    }
    writeJsonAtomic(attemptFile(dir), { ...rec, phase: 'finished', outcome: 'scored-failure', accepted: false, evaluation: { status: 'not-run', verdictFile: null, durationMs: null, snapshotHash: null, reason } });
    return;
  }
  const evalRuns = existsSync(runtimeDir) ? countPrefix(runtimeDir, 'eval-') : 0;
  const workDir = join(runtimeDir, `eval-${evalRuns + 1}`);
  const verdictPath = join(workDir, 'verdict.json');
  log('evaluation-started', { slot: slot.slot, attempt: rec.attempt });
  const started = deps.now();
  const s = await deps.evaluate({ snapshotDir, workDir, verdictPath });
  const durationMs = deps.now() - started;
  if (s.kind === 'infrastructure-failure' || s.verdict.status === 'infrastructure-failure') {
    const reason = s.kind === 'infrastructure-failure' ? s.reason : (s.verdict.reason ?? 'evaluator infrastructure failure');
    writeJsonAtomic(attemptFile(dir), {
      ...rec,
      phase: 'finished',
      outcome: 'operational',
      termination: 'evaluator-infrastructure-failure' as WorkflowTermination,
      terminationDetail: reason,
      scoredTerminationBeforeEvaluation: rec.termination,
      accepted: null,
      evaluation: { status: 'not-run', verdictFile: null, durationMs, snapshotHash: rec.finalSnapshotHash, reason },
    });
    log('evaluation-ended', { slot: slot.slot, attempt: rec.attempt, status: 'infrastructure-failure' });
    return;
  }
  deps.copyFile(verdictPath, join(dir, 'verdict.json'));
  const passed = s.verdict.status === 'passed';
  writeJsonAtomic(attemptFile(dir), {
    ...rec,
    phase: 'finished',
    outcome: completed ? 'completed' : 'scored-failure',
    accepted: completed && passed,
    evaluation: { status: s.verdict.status, verdictFile: 'verdict.json', durationMs: s.verdict.durationMs, snapshotHash: s.verdict.snapshot.hash ?? rec.finalSnapshotHash, reason: null },
  });
  log('evaluation-ended', { slot: slot.slot, attempt: rec.attempt, status: s.verdict.status, accepted: completed && passed });
}

function blankRecord(cfg: CampaignConfig, slot: ScheduleSlot, attempt: number, replaces: number | null, startedAt: string, waitBeforeMs: number, waitReason: string | null): AttemptRecord {
  return {
    schema: ATTEMPT_SCHEMA,
    campaign: cfg.label,
    block: slot.block,
    slot: slot.slot,
    conditionId: slot.conditionId,
    attempt,
    replaces,
    phase: 'running',
    startedAt,
    endedAt: null,
    activeMs: null,
    waitBeforeMs,
    waitReason,
    termination: null,
    terminationDetail: null,
    outcome: null,
    accepted: null,
    evaluation: null,
    sensorRepairs: 0,
    stages: [],
    finalSnapshotHash: null,
    manualHandling: null,
  };
}

function countPrefix(dir: string, prefix: string): number {
  return readdirSync(dir).filter((n) => n.startsWith(prefix)).length;
}

/** Runtime directories are disposable scratch, but only ever below the runtime root. */
function rmSyncGuard(dir: string, root: string): void {
  if (!dir.startsWith(`${root}/`)) throw new Error(`refusing to remove ${dir} outside ${root}`);
  rmSync(dir, { recursive: true, force: true });
}

/** One runner per campaign label: an exclusive lock file holding the runner's pid. */
export function acquireLock(path: string, log: (t: string, f: Record<string, unknown>) => void, alive: (pid: number) => boolean = pidAlive): () => void {
  const take = () => {
    const fd = openSync(path, 'wx', 0o644);
    writeSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    take();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error(`another runner (pid ${pid}) holds ${path}`);
    log('stale-lock-cleared', { pid });
    rmSync(path, { force: true });
    take();
  }
  return () => rmSync(path, { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
