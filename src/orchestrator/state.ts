/**
 * Durable checkpoints. Every attempt has an `attempt.json` that is rewritten atomically (write to a
 * temporary file, fsync, rename) and an append-only `transitions.jsonl`, each line fsynced before the
 * runner acts on it. After a crash the records alone say which slots are done, which attempt was
 * interrupted mid-stage, and which finished workflow still awaits evaluation.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StageTermination } from '../adapters/types.ts';

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o644);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Workflow terminal states: the adapter vocabulary plus orchestration-level outcomes (methodology section 8). */
export type WorkflowTermination = StageTermination | 'task-timeout' | 'failed-required-handoff' | 'repair-budget-exhausted' | 'evaluator-infrastructure-failure';

export const SCORED_FAILURES: ReadonlySet<string> = new Set(['task-timeout', 'stage-timeout', 'failed-required-handoff', 'repair-budget-exhausted', 'model-error-exit']);
export const OPERATIONAL: ReadonlySet<string> = new Set(['auth-missing', 'quota-exhausted', 'provider-outage', 'model-substituted', 'runner-infrastructure-failure', 'evaluator-infrastructure-failure']);

export type OutcomeClass = 'completed' | 'scored-failure' | 'operational';

export function classify(t: WorkflowTermination): OutcomeClass {
  if (t === 'completed') return 'completed';
  if (SCORED_FAILURES.has(t)) return 'scored-failure';
  if (OPERATIONAL.has(t)) return 'operational';
  throw new Error(`unclassified termination ${t}`);
}

export const ATTEMPT_SCHEMA = 'harness-benchmark/attempt@1';

/**
 * - `running`: the workflow is executing (or the runner died while it was).
 * - `awaiting-evaluation`: a scored terminal state is recorded; the frozen snapshot is not yet evaluated.
 * - `finished`: final. `outcome` says whether it is scored or operational.
 */
export type AttemptPhase = 'running' | 'awaiting-evaluation' | 'finished';

export interface AttemptRecord {
  schema: typeof ATTEMPT_SCHEMA;
  campaign: string;
  block: number;
  slot: number;
  conditionId: string;
  attempt: number;
  /** Attempt number this one replaces (operational replacement link), or null. */
  replaces: number | null;
  /** Pilots only: the finished, unexercised pilot attempt this fresh attempt retries (never a scored failure). */
  pilotRetryOf?: number;
  phase: AttemptPhase;
  startedAt: string;
  endedAt: string | null;
  /** Active workflow time from first stage start to terminal state (excludes evaluation and waits). */
  activeMs: number | null;
  /** Time the slot spent paused before this attempt started (quota, outage backoff, manual). */
  waitBeforeMs: number;
  waitReason: string | null;
  termination: WorkflowTermination | null;
  terminationDetail: string | null;
  outcome: OutcomeClass | null;
  /** Null until evaluated; false for scored failures and app-caused rejections. */
  accepted: boolean | null;
  evaluation: {
    status: 'passed' | 'failed' | 'not-run';
    verdictFile: string | null;
    durationMs: number | null;
    snapshotHash: string | null;
    reason: string | null;
  } | null;
  sensorRepairs: number;
  stages: StageSummary[];
  finalSnapshotHash: string | null;
  manualHandling: string | null;
  /** Operating environment captured when the attempt started (absent on records from before it was added). */
  environment?: unknown;
}

export interface StageSummary {
  id: string;
  kind: string;
  role: string;
  mode: 'fresh' | 'resume';
  resumedSession: string | null;
  sessionId: string | null;
  requestedModel: string;
  resolvedModel: string | null;
  termination: string;
  terminationDetail: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  promptSha256: string;
  workspaceHashBefore: string | null;
  workspaceHashAfter: string | null;
  handoff: { kind: string; status: string; sha256: string | null; originalBytes: number; truncated: boolean; file: string | null } | null;
  usageCompleteness: string;
  recordDir: string;
}

export type TransitionEvent = { at: string; type: string } & Record<string, unknown>;

export const attemptFile = (dir: string) => join(dir, 'attempt.json');
export const transitionsFile = (dir: string) => join(dir, 'transitions.jsonl');

export function listAttemptDirs(slotDir: string): { attempt: number; dir: string }[] {
  if (!existsSync(slotDir)) return [];
  return readdirSync(slotDir)
    .map((n) => ({ n, m: /^attempt-(\d+)$/.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .map(({ n, m }) => ({ attempt: Number(m[1]), dir: join(slotDir, n) }))
    .sort((a, b) => a.attempt - b.attempt);
}
