/**
 * Maps a stored attempt record onto the gate's `PilotAttempt` view. Shared by the freeze gate CLI
 * and the pilot campaign's retry decision, so both judge "exercised" from the same fields.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellHealth, type ShellHealth } from '../audit/shell.ts';
import { workflowPlan, type LimitsConfig } from '../orchestrator/plan.ts';
import { parseConditionId } from '../orchestrator/schedule.ts';
import { readJson, type AttemptRecord } from '../orchestrator/state.ts';
import { exerciseProblems, type PilotAttempt } from './gate.ts';

/**
 * Pure: `isolationOf` supplies `settings.isolation.mechanism` and `shellOf` the shell health for a
 * stage's record directory.
 */
export function toPilotAttempt(r: AttemptRecord, isolationOf: (recordDir: string) => string | null, shellOf: (recordDir: string) => ShellHealth | null): PilotAttempt {
  return {
    conditionId: r.conditionId,
    attempt: r.attempt,
    phase: r.phase,
    outcome: r.outcome,
    termination: r.termination,
    activeMs: r.activeMs,
    evaluation: r.evaluation ? { status: r.evaluation.status, durationMs: r.evaluation.durationMs } : null,
    stages: r.stages.map((s) => ({
      id: s.id,
      kind: s.kind,
      role: s.role,
      mode: s.mode,
      sessionId: s.sessionId,
      resumedSession: s.resumedSession,
      requestedModel: s.requestedModel,
      resolvedModel: s.resolvedModel,
      termination: s.termination,
      workspaceHashBefore: s.workspaceHashBefore,
      workspaceHashAfter: s.workspaceHashAfter,
      handoff: s.handoff ? { kind: s.handoff.kind, status: s.handoff.status, sha256: s.handoff.sha256, file: s.handoff.file } : null,
      usageCompleteness: s.usageCompleteness,
      isolationMechanism: isolationOf(s.recordDir),
      shell: shellOf(s.recordDir),
    })),
  };
}

/** Reads each stage's isolation mechanism from `<attemptDir>/<recordDir>/stage.json`; null when absent. */
export function isolationReader(attemptDir: string): (recordDir: string) => string | null {
  return (recordDir) => {
    const st = readJson<{ settings?: { isolation?: { mechanism?: unknown } } }>(join(attemptDir, recordDir, 'stage.json'));
    const m = st?.settings?.isolation?.mechanism;
    return typeof m === 'string' ? m : null;
  };
}

/**
 * Reads each stage's shell health from `<attemptDir>/<recordDir>/events.jsonl`, using the provider
 * in its stage.json; null when either file is absent or the provider is unknown.
 */
export function shellReader(attemptDir: string): (recordDir: string) => ShellHealth | null {
  return (recordDir) => {
    const st = readJson<{ provider?: unknown }>(join(attemptDir, recordDir, 'stage.json'));
    const provider = st?.provider;
    if (provider !== 'anthropic' && provider !== 'openai') return null;
    let text: string;
    try {
      text = readFileSync(join(attemptDir, recordDir, 'events.jsonl'), 'utf8');
    } catch {
      return null;
    }
    return shellHealth(provider, text);
  };
}

/**
 * The pilot campaign's retry predicate: true when this finished pilot did not exercise its
 * configuration's planned workflow. It is the freeze gate's `pilot-exercise` test, applied to one
 * stored attempt against the runner's own stage plan.
 */
export function pilotLeftUnexercised(limits: LimitsConfig): (rec: AttemptRecord, attemptDir: string) => boolean {
  return (rec, attemptDir) => exerciseProblems(toPilotAttempt(rec, isolationReader(attemptDir), shellReader(attemptDir)), workflowPlan(parseConditionId(rec.conditionId), limits)).length > 0;
}
