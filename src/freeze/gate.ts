/**
 * Pre-scoring freeze gate (methodology section 14). Pure: every input is gathered by
 * `src/cli/freeze.ts`, so the decision can be unit-tested without a live CLI, sandbox or model.
 *
 * Three separate questions about the pilots:
 *
 * - coverage: did each configuration get a retained, finished, non-operational pilot? Early failures
 *   count here, because failed pilots are kept, never discarded.
 * - exercise: did some pilot of each configuration actually run every planned stage with the
 *   planned fresh/resumed session boundaries, handoffs, read-only snapshots, OS isolation, and
 *   complete usage counters, and a working shell in each fresh implement stage (`shellProblem`)? An
 *   early failure covers a configuration but does not exercise it.
 * - estimate: does every configuration have a valid observed active and evaluation duration? A
 *   missing or invalid duration blocks freezing; it is never treated as zero.
 *
 * Safeguards that the records cannot prove mechanically (paid-overflow guard, quota pausing,
 * recovery) must be backed by explicit evidence references or a dated human attestation.
 */
import { createHash } from 'node:crypto';
import type { StagePlan } from '../orchestrator/plan.ts';
import { shellProblem, type ShellHealth } from '../audit/shell.ts';

export interface PilotStage {
  id: string;
  kind: string;
  role: string;
  mode: string;
  sessionId: string | null;
  resumedSession: string | null;
  requestedModel: string;
  resolvedModel: string | null;
  termination: string;
  workspaceHashBefore: string | null;
  workspaceHashAfter: string | null;
  handoff: { kind: string; status: string; sha256: string | null; file: string | null } | null;
  usageCompleteness: string;
  /** `settings.isolation.mechanism` from the stage's stage.json; null when the record is absent. */
  isolationMechanism: string | null;
  /**
   * Shell health from the stage's events.jsonl (`src/audit/shell.ts`); null when no event stream was
   * recorded. Judged for planned fresh implement stages only.
   */
  shell: ShellHealth | null;
}

export interface PilotAttempt {
  conditionId: string;
  attempt: number;
  phase: string;
  outcome: string | null;
  termination: string | null;
  activeMs: number | null;
  evaluation: { status: string; durationMs: number | null } | null;
  stages: PilotStage[];
}

export interface PreflightStatus {
  ok: boolean;
  termination: string | null;
}

/** The stage-plan fields the exercise check compares against. */
export type PlannedStage = Pick<StagePlan, 'id' | 'kind' | 'role' | 'session' | 'produces' | 'permission'>;

export const REQUIRED_SAFEGUARDS = ['paid-overflow-guard', 'quota-pausing', 'recovery'] as const;

export interface SafeguardEvidence {
  id: string;
  kind: string;
  statement: string;
  refs: string[];
  attestedBy: string | null;
  attestedAt: string | null;
  /** Refs the CLI could not resolve to a file under the benchmark root. */
  missingRefs: string[];
}

export interface GateInputs {
  conditions: readonly string[];
  /** Planned stages per condition, from `workflowPlan` (the runner's only source of stages). */
  plans: Readonly<Record<string, readonly PlannedStage[]>>;
  attempts: readonly PilotAttempt[];
  preflight: { codex: PreflightStatus; claude: PreflightStatus };
  /** Path of a sandbox tool that actually applied a probe sandbox, or null. */
  sandboxTool: string | null;
  scheduleReproduces: boolean;
  usageSemantics: { codex: { status: string; turnCompletedScope: unknown; cachedInputSubsetOfInput: unknown; reasoningIncludedInOutput: unknown } };
  priceSnapshot: { present: boolean };
  safeguards: readonly SafeguardEvidence[];
  repetitions: number;
  /**
   * Unmet conditions from the recorded host evidence (`evaluateHostEvidence`), when the gate judges
   * the runner's recorded preflights and isolation probe rather than probing the local machine.
   */
  hostEvidence?: readonly Unmet[];
}

export interface Unmet {
  id: string;
  detail: string;
}

export interface PilotObservation {
  conditionId: string;
  attempt: number;
  activeMs: number;
  evaluationMs: number;
}

export interface PilotEstimate {
  basis: string;
  pilotActiveHours: number;
  pilotEvaluationHours: number;
  activeHours: number;
  evaluationHours: number;
  /** The observed durations the estimate is built from, one per configuration. */
  observations: PilotObservation[];
}

export type EstimateGapReason = 'no-exercised-pilot' | 'active-missing' | 'active-invalid' | 'evaluation-not-run' | 'evaluation-duration-unknown' | 'evaluation-duration-invalid';

export interface EstimateGap {
  conditionId: string;
  attempt: number | null;
  reason: EstimateGapReason;
}

export interface GateResult {
  ready: boolean;
  unmet: Unmet[];
  warnings: string[];
  coverage: ReturnType<typeof pilotCoverage>;
  exercise: ReturnType<typeof pilotExerciseCoverage>;
  estimate: PilotEstimate | null;
  estimateGaps: EstimateGap[];
}

const covers = (a: PilotAttempt) => a.phase === 'finished' && (a.outcome === 'completed' || a.outcome === 'scored-failure');
const ISOLATING = new Set(['sandbox-exec', 'bwrap']);

/** Which configurations have a retained, finished, non-operational pilot (failures included). */
export function pilotCoverage(conditions: readonly string[], attempts: readonly PilotAttempt[]) {
  const ok = new Set(attempts.filter(covers).map((a) => a.conditionId));
  return {
    covered: conditions.filter((c) => ok.has(c)),
    missing: conditions.filter((c) => !ok.has(c)),
    operational: attempts.filter((a) => a.outcome === 'operational').map((a) => ({ conditionId: a.conditionId, attempt: a.attempt, termination: a.termination })),
  };
}

/**
 * Problems preventing one pilot from demonstrating its workflow; empty means exercised. Checks the
 * attempt against the planned stages, not against whatever stages happen to be recorded, so an
 * empty or truncated stage list can never pass.
 */
export function exerciseProblems(a: PilotAttempt, plan: readonly PlannedStage[]): string[] {
  const p: string[] = [];
  if (!covers(a)) p.push(`attempt ${a.attempt} is not a finished, non-operational pilot (phase ${a.phase}, outcome ${a.outcome ?? 'none'})`);
  if (plan.length === 0) p.push('no planned stages for this configuration');
  const byId = new Map(a.stages.map((s) => [s.id, s]));
  const freshSessions = new Map<string, string>();
  for (const sp of plan) {
    const s = byId.get(sp.id);
    if (!s) {
      p.push(`${sp.id} did not run`);
      continue;
    }
    if (s.kind !== sp.kind || s.role !== sp.role) p.push(`${sp.id} ran as ${s.kind}/${s.role}, planned ${sp.kind}/${sp.role}`);
    if (sp.session.kind === 'fresh') {
      if (s.mode !== 'fresh' || s.resumedSession !== null) p.push(`${sp.id} should start a fresh session (mode ${s.mode})`);
      if (!s.sessionId) p.push(`${sp.id} recorded no session id`);
      else if (freshSessions.has(s.sessionId)) p.push(`${sp.id} reused the session of ${freshSessions.get(s.sessionId)}; fresh boundary not demonstrated`);
      else freshSessions.set(s.sessionId, sp.id);
    } else {
      const prior = byId.get(sp.session.ofStage);
      if (s.mode !== 'resume') p.push(`${sp.id} should resume ${sp.session.ofStage} (mode ${s.mode})`);
      if (!s.resumedSession || !prior?.sessionId || s.resumedSession !== prior.sessionId) p.push(`${sp.id} did not resume the session of ${sp.session.ofStage}`);
    }
    if (sp.produces) {
      const h = s.handoff;
      if (!h || h.kind !== sp.produces || h.status !== 'ok' || !h.sha256 || !h.file) p.push(`${sp.id} produced no usable ${sp.produces} handoff (${h ? `${h.kind} ${h.status}` : 'none'})`);
    }
    if (sp.permission === 'read-only' && (!s.workspaceHashBefore || s.workspaceHashBefore !== s.workspaceHashAfter)) p.push(`${sp.id} did not show an unchanged read-only snapshot`);
  }
  // A working shell: every planned fresh implement stage must run at least one command
  // successfully (methodology section 15, 2026-11-22). Fix and repair stages are not judged: a failing build there is not a broken shell.
  for (const sp of plan) {
    if (sp.kind !== 'implement' || sp.permission !== 'workspace-write' || sp.session.kind !== 'fresh') continue;
    const s = byId.get(sp.id);
    if (!s) continue;
    const why = shellProblem(s.shell);
    if (why) p.push(`${sp.id} shell: ${why}`);
  }
  for (const s of a.stages) {
    if (s.usageCompleteness !== 'complete') p.push(`${s.id} usage ${s.usageCompleteness}`);
    if (!s.isolationMechanism || !ISOLATING.has(s.isolationMechanism)) p.push(`${s.id} isolation ${s.isolationMechanism ?? 'unrecorded'}`);
    if (s.resolvedModel === null) p.push(`${s.id} resolved model unrecorded`);
  }
  return p;
}

const lastExercised = (c: string, attempts: readonly PilotAttempt[], plan: readonly PlannedStage[]) =>
  attempts.filter((a) => a.conditionId === c && exerciseProblems(a, plan).length === 0).at(-1);

/** Which configurations have a pilot that exercised the whole workflow, with reasons otherwise. */
export function pilotExerciseCoverage(conditions: readonly string[], plans: GateInputs['plans'], attempts: readonly PilotAttempt[]) {
  const exercised: { conditionId: string; attempt: number }[] = [];
  const unexercised: { conditionId: string; problems: string[] }[] = [];
  for (const c of conditions) {
    const plan = plans[c] ?? [];
    const hit = lastExercised(c, attempts, plan);
    if (hit) {
      exercised.push({ conditionId: c, attempt: hit.attempt });
      continue;
    }
    const own = attempts.filter((a) => a.conditionId === c);
    unexercised.push({ conditionId: c, problems: own.length === 0 ? ['no pilot attempt'] : own.flatMap((a) => exerciseProblems(a, plan).map((x) => `attempt ${a.attempt}: ${x}`)) });
  }
  return { exercised, unexercised };
}

const validMs = (v: number | null, allowZero: boolean): boolean => v !== null && Number.isFinite(v) && (allowZero ? v >= 0 : v > 0);

/**
 * Pilot-based estimate of scored subscription time: each configuration's most recent exercised
 * pilot, active and evaluation time, multiplied by the repetitions. Any configuration without a
 * valid observed duration makes the estimate unavailable and is listed as a gap; unknown or
 * not-run evaluation is reported as such, never counted as zero. A single pilot per configuration
 * is a weak basis: the estimate is a scheduling figure, not a prediction of scored runtimes.
 */
export function pilotEstimate(conditions: readonly string[], plans: GateInputs['plans'], attempts: readonly PilotAttempt[], repetitions: number): { estimate: PilotEstimate | null; gaps: EstimateGap[] } {
  const gaps: EstimateGap[] = [];
  const observations: PilotObservation[] = [];
  for (const c of conditions) {
    const a = lastExercised(c, attempts, plans[c] ?? []);
    if (!a) {
      gaps.push({ conditionId: c, attempt: null, reason: 'no-exercised-pilot' });
      continue;
    }
    const before = gaps.length;
    if (a.activeMs === null) gaps.push({ conditionId: c, attempt: a.attempt, reason: 'active-missing' });
    else if (!validMs(a.activeMs, false)) gaps.push({ conditionId: c, attempt: a.attempt, reason: 'active-invalid' });
    const ev = a.evaluation;
    if (!ev || ev.status === 'not-run') gaps.push({ conditionId: c, attempt: a.attempt, reason: 'evaluation-not-run' });
    else if (ev.durationMs === null) gaps.push({ conditionId: c, attempt: a.attempt, reason: 'evaluation-duration-unknown' });
    else if (!validMs(ev.durationMs, true)) gaps.push({ conditionId: c, attempt: a.attempt, reason: 'evaluation-duration-invalid' });
    if (gaps.length === before) observations.push({ conditionId: c, attempt: a.attempt, activeMs: a.activeMs!, evaluationMs: ev!.durationMs! });
  }
  if (gaps.length > 0 || conditions.length === 0 || !(Number.isInteger(repetitions) && repetitions > 0)) return { estimate: null, gaps };
  const h = (ms: number) => ms / 3_600_000;
  const active = observations.reduce((s, o) => s + o.activeMs, 0);
  const evaluation = observations.reduce((s, o) => s + o.evaluationMs, 0);
  return {
    estimate: {
      basis: `one exercised pilot per configuration (${conditions.length}), concurrency one, multiplied by ${repetitions} repetitions; excludes replacements, quota waits and manual handling`,
      pilotActiveHours: h(active),
      pilotEvaluationHours: h(evaluation),
      activeHours: h(active) * repetitions,
      evaluationHours: h(evaluation) * repetitions,
      observations,
    },
    gaps,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

/** Problems with the evidence for each safeguard the records cannot prove mechanically. */
export function safeguardProblems(evidence: readonly SafeguardEvidence[]): Unmet[] {
  const out: Unmet[] = [];
  for (const id of REQUIRED_SAFEGUARDS) {
    const e = evidence.find((x) => x.id === id);
    const fail = (detail: string) => out.push({ id: `safeguard:${id}`, detail });
    if (!e) {
      fail('no recorded evidence or human attestation');
      continue;
    }
    if (!e.statement.trim()) fail('evidence entry has no statement of what was demonstrated');
    if (e.refs.length === 0) fail('evidence entry cites no record or hand-off file');
    if (e.missingRefs.length > 0) fail(`cited files not found: ${e.missingRefs.join(', ')}`);
    if (e.kind === 'human-attestation') {
      if (!e.attestedBy?.trim() || !e.attestedAt || !ISO_DATE.test(e.attestedAt)) fail('human attestation needs attestedBy and an ISO attestedAt date');
    } else if (e.kind !== 'record') {
      fail(`unknown evidence kind ${JSON.stringify(e.kind)} (expected record or human-attestation)`);
    }
  }
  return out;
}

/** Order-independent digest of a file tree from its relative paths and content hashes. */
export function treeDigest(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.sha256}  ${JSON.stringify(f.path)}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/**
 * The sandbox mechanism a tool path names, judged by its basename: `bwrap` or `sandbox-exec`, else
 * null. The gate accepts only a path that names one of the sandboxes `src/evaluator/sandbox.ts` can
 * apply, so an arbitrary truthy value (for example `/usr/bin/false`) cannot satisfy isolation.
 */
export function sandboxMechanism(tool: string | null | undefined): 'bwrap' | 'sandbox-exec' | null {
  if (typeof tool !== 'string' || tool === '') return null;
  const base = tool.split('/').at(-1);
  return base === 'bwrap' ? 'bwrap' : base === 'sandbox-exec' ? 'sandbox-exec' : null;
}

const summarise = (xs: string[], n = 3) => (xs.length <= n ? xs.join('; ') : `${xs.slice(0, n).join('; ')}; +${xs.length - n} more`);

export function evaluateGate(i: GateInputs): GateResult {
  const unmet: Unmet[] = [...(i.hostEvidence ?? [])];
  const warnings: string[] = [];
  for (const p of ['codex', 'claude'] as const) {
    const s = i.preflight[p];
    if (!s.ok) unmet.push({ id: `subscription-access:${p}`, detail: `${p} preflight not ok (${s.termination ?? 'unknown'}); a human must create the isolated subscription login` });
  }
  if (!i.sandboxTool) unmet.push({ id: 'isolation', detail: 'no OS sandbox tool could apply a probe sandbox in this environment; scored blocks require --isolation required' });
  else if (sandboxMechanism(i.sandboxTool) === null) unmet.push({ id: 'isolation', detail: `sandbox tool ${i.sandboxTool} is neither bwrap nor sandbox-exec; scored blocks require --isolation required` });
  if (!i.scheduleReproduces) unmet.push({ id: 'schedule', detail: 'config/schedule.json does not reproduce from the seed' });
  const cx = i.usageSemantics.codex;
  if (cx.status === 'unverified' || cx.turnCompletedScope === null || cx.cachedInputSubsetOfInput === null || cx.reasoningIncludedInOutput === null) {
    unmet.push({ id: 'usage-semantics:codex', detail: 'Codex counter semantics are unsettled in config/usage-semantics.json; a resumed pilot stage must settle them' });
  }
  const coverage = pilotCoverage(i.conditions, i.attempts);
  if (coverage.missing.length > 0) unmet.push({ id: 'pilots', detail: `${coverage.missing.length} of ${i.conditions.length} configurations lack a retained, finished pilot` });
  const exercise = pilotExerciseCoverage(i.conditions, i.plans, i.attempts);
  if (exercise.unexercised.length > 0) {
    unmet.push({
      id: 'pilot-exercise',
      detail: `${exercise.unexercised.length} of ${i.conditions.length} configurations lack a pilot that exercised every stage, session boundary, handoff, isolation, usage record and working shell: ${summarise(exercise.unexercised.map((u) => `${u.conditionId} (${u.problems[0] ?? 'unknown'})`))}`,
    });
  }
  const substituted = i.attempts.flatMap((a) => a.stages.filter((s) => s.resolvedModel !== null && s.resolvedModel !== s.requestedModel).map((s) => `${a.conditionId}#${a.attempt}:${s.role} requested ${s.requestedModel}, resolved ${s.resolvedModel}`));
  if (substituted.length > 0) unmet.push({ id: 'resolved-models', detail: substituted.join('; ') });
  const { estimate, gaps } = pilotEstimate(i.conditions, i.plans, i.attempts, i.repetitions);
  if (!estimate) {
    unmet.push({ id: 'pilot-estimate', detail: gaps.length > 0 ? `no pilot-based time estimate: ${summarise(gaps.map((g) => `${g.conditionId} ${g.reason}`))}` : 'no pilot-based time estimate (no configurations or invalid repetitions)' });
  }
  unmet.push(...safeguardProblems(i.safeguards));
  if (!i.priceSnapshot.present) warnings.push('no price snapshot: dollars stay unresolved, which does not block scoring');
  return { ready: unmet.length === 0, unmet, warnings, coverage, exercise, estimate, estimateGaps: gaps };
}
