/**
 * The deterministic build-time feedback loop (the treatment; methodology section 5).
 *
 * After an implement, fix, or sensor-repair stage returns with checks `on`, the runner runs its
 * protected checks. On failure it sends bounded feedback and resumes the same implementer, at most
 * `maxRepairs` times per workflow in total, and gates completion after the final stage. With checks
 * `off` nothing runs and nothing is sent. Passing the checks never implies acceptance.
 */
import { formatFeedback, renderRepairPrompt } from './feedback.ts';
import type { CheckRun } from './types.ts';

export type StagePosition = 'intermediate' | 'final';
export type LoopTermination = 'repair-budget-exhausted' | 'stage-timeout' | 'task-timeout' | 'runner-infrastructure-failure';

export type Decision =
  | { action: 'proceed' }
  | { action: 'repair'; repairsLeftAfter: number }
  | { action: 'continue-failing'; reason: 'repairs-exhausted' | 'stage-time-exhausted' }
  | { action: 'terminate'; termination: LoopTermination };

export interface DecisionInput {
  run: CheckRun['status'];
  position: StagePosition;
  /** Sensor repairs already used in this workflow, across all stages. */
  repairsUsed: number;
  maxRepairs: number;
  stageRemainingMs: number;
  workflowRemainingMs: number;
}

/**
 * Pure stopping rule. A pass proceeds. A failure is repaired while repairs and stage time remain.
 * Otherwise an intermediate stage continues to its scheduled review, and the final stage ends as
 * `repair-budget-exhausted` (no repairs left) or `stage-timeout` (no stage time left to repair in).
 */
export function decide(i: DecisionInput): Decision {
  if (i.run === 'infrastructure-failure') return { action: 'terminate', termination: 'runner-infrastructure-failure' };
  if (i.run === 'passed') return { action: 'proceed' };
  if (i.workflowRemainingMs <= 0) return { action: 'terminate', termination: 'task-timeout' };
  if (i.repairsUsed >= i.maxRepairs) {
    return i.position === 'final' ? { action: 'terminate', termination: 'repair-budget-exhausted' } : { action: 'continue-failing', reason: 'repairs-exhausted' };
  }
  if (i.stageRemainingMs <= 0) {
    return i.position === 'final' ? { action: 'terminate', termination: 'stage-timeout' } : { action: 'continue-failing', reason: 'stage-time-exhausted' };
  }
  return { action: 'repair', repairsLeftAfter: i.maxRepairs - i.repairsUsed - 1 };
}

export interface LoopInput {
  checkCondition: 'on' | 'off';
  position: StagePosition;
  repairsUsed: number;
  maxRepairs: number;
  /** Absolute times on `deps.now()`'s clock. Checks and repairs consume the owning stage's budget. */
  stageDeadlineAt: number;
  workflowDeadlineAt: number;
  checkCeilingMs: number;
  feedbackMaxBytes: number;
  replacements?: Record<string, string>;
}

/** How a resumed repair stage ended: it returned normally, or the adapter ended the stage (timeout, error). */
export type RepairOutcome = { kind: 'returned' } | { kind: 'ended'; termination: string };

export interface LoopDeps {
  /** Monotonic milliseconds. */
  now(): number;
  wallClock(): Date;
  /** Runs the protected checks on the current workspace state. */
  runChecks(timeoutMs: number): Promise<CheckRun>;
  /** Resumes the implementer that produced the failing state with the repair prompt. */
  repair(prompt: string, ctx: { deadlineAt: number; index: number }): Promise<RepairOutcome>;
  /** Text of prompts/sensor-repair.md. */
  repairTemplate: string;
}

export type LoopEvent =
  | { type: 'checks'; at: string; elapsedMs: number; timeoutMs: number; status: CheckRun['status']; failing: string[]; run: CheckRun; decision: Decision }
  | {
      type: 'repair';
      index: number;
      at: string;
      elapsedMs: number;
      repairsLeftAfter: number;
      stageMinutesLeft: number;
      feedback: string;
      feedbackBytes: number;
      outcome: RepairOutcome;
    };

export interface LoopResult {
  /** `proceed`: checks passed or are off. `continue-failing`: intermediate stage moves on with failing checks. */
  outcome: 'proceed' | 'continue-failing' | 'terminate';
  termination: string | null;
  /** Workflow total after this loop, to pass to the next stage's loop. */
  repairsUsed: number;
  lastRun: CheckRun | null;
  events: LoopEvent[];
}

export async function runFeedbackLoop(input: LoopInput, deps: LoopDeps): Promise<LoopResult> {
  const events: LoopEvent[] = [];
  let repairsUsed = input.repairsUsed;
  let lastRun: CheckRun | null = null;
  const done = (outcome: LoopResult['outcome'], termination: string | null): LoopResult => ({ outcome, termination, repairsUsed, lastRun, events });
  if (input.checkCondition === 'off') return done('proceed', null);

  // Each pass either ends the loop or consumes one repair, so this terminates within maxRepairs + 1 check runs.
  for (;;) {
    const workflowRemaining = input.workflowDeadlineAt - deps.now();
    if (workflowRemaining <= 0) return done('terminate', 'task-timeout');
    const timeoutMs = Math.min(input.checkCeilingMs, workflowRemaining);
    const started = deps.now();
    const at = deps.wallClock().toISOString();
    const run = await deps.runChecks(timeoutMs);
    lastRun = run;
    const now = deps.now();
    const decision = decide({
      run: run.status,
      position: input.position,
      repairsUsed,
      maxRepairs: input.maxRepairs,
      stageRemainingMs: input.stageDeadlineAt - now,
      workflowRemainingMs: input.workflowDeadlineAt - now,
    });
    const failing = run.suites.flatMap((s) => [...s.checks.filter((c) => !c.passed).map((c) => c.name), ...(s.status === 'timed-out' || s.status === 'not-run' ? [`${s.suite}:${s.status}`] : [])]);
    events.push({ type: 'checks', at, elapsedMs: Math.round(now - started), timeoutMs, status: run.status, failing, run, decision });

    if (decision.action === 'proceed') return done('proceed', null);
    if (decision.action === 'continue-failing') return done('continue-failing', null);
    if (decision.action === 'terminate') return done('terminate', decision.termination);

    const stageMinutesLeft = (input.stageDeadlineAt - now) / 60_000;
    const feedback = formatFeedback(run, { repairsLeft: decision.repairsLeftAfter, stageMinutesLeft, maxBytes: input.feedbackMaxBytes, replacements: input.replacements });
    const prompt = renderRepairPrompt(deps.repairTemplate, feedback, decision.repairsLeftAfter);
    repairsUsed += 1;
    const repairStarted = deps.now();
    const repairAt = deps.wallClock().toISOString();
    const outcome = await deps.repair(prompt, { deadlineAt: input.stageDeadlineAt, index: repairsUsed });
    events.push({
      type: 'repair',
      index: repairsUsed,
      at: repairAt,
      elapsedMs: Math.round(deps.now() - repairStarted),
      repairsLeftAfter: decision.repairsLeftAfter,
      stageMinutesLeft,
      feedback,
      feedbackBytes: Buffer.byteLength(feedback),
      outcome,
    });
    if (outcome.kind === 'ended') return done('terminate', outcome.termination);
  }
}
