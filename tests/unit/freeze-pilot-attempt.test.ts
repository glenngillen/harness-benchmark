import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import { isolationReader, pilotLeftUnexercised, shellReader, toPilotAttempt } from '../../src/freeze/pilot-attempt.ts';
import type { ShellHealth } from '../../src/audit/shell.ts';
import { workflowPlan } from '../../src/orchestrator/plan.ts';
import { parseConditionId } from '../../src/orchestrator/schedule.ts';
import { ATTEMPT_SCHEMA, type AttemptRecord, type StageSummary } from '../../src/orchestrator/state.ts';

const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const LIMITS = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'limits.json'), 'utf8'));
const COND = 'irf.CC-AF-CC.off';

function exercisedRecord(): AttemptRecord {
  const plan = workflowPlan(parseConditionId(COND), LIMITS);
  const stages: StageSummary[] = plan.map((sp, n) => ({
    id: sp.id,
    kind: sp.kind,
    role: sp.role,
    mode: sp.session.kind,
    sessionId: sp.session.kind === 'fresh' ? `sess-${n}` : null,
    resumedSession: sp.session.kind === 'resume' ? `sess-${plan.findIndex((p) => sp.session.kind === 'resume' && p.id === sp.session.ofStage)}` : null,
    requestedModel: 'm',
    resolvedModel: 'm',
    termination: 'completed',
    terminationDetail: null,
    startedAt: '2026-11-20T00:00:00Z',
    endedAt: '2026-11-20T00:01:00Z',
    durationMs: 60_000,
    promptSha256: 'p',
    workspaceHashBefore: `h${n}`,
    workspaceHashAfter: sp.permission === 'read-only' ? `h${n}` : `h${n}x`,
    handoff: sp.produces ? { kind: sp.produces, status: 'ok', sha256: 'f'.repeat(64), originalBytes: 10, truncated: false, file: `handoffs/${sp.produces}.md` } : null,
    usageCompleteness: 'complete',
    recordDir: `stages/${sp.id}`,
  }));
  return {
    schema: ATTEMPT_SCHEMA, campaign: 'pilots', block: 0, slot: 1, conditionId: COND, attempt: 1, replaces: null, phase: 'finished',
    startedAt: '2026-11-20T00:00:00Z', endedAt: '2026-11-20T00:03:00Z', activeMs: 180_000, waitBeforeMs: 0, waitReason: null,
    termination: 'completed', terminationDetail: null, outcome: 'completed', accepted: true,
    evaluation: { status: 'passed', verdictFile: 'verdict.json', durationMs: 30_000, snapshotHash: 's', reason: null },
    sensorRepairs: 0, stages, finalSnapshotHash: 's', manualHandling: null,
  };
}

// One Codex command per stage: exit 0 by default, or the given exit code.
const codexEvents = (exit: number) => `${JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm run build', aggregated_output: '', exit_code: exit } })}\n`;

function writeStageRecords(rec: AttemptRecord, mechanism: string, exit = 0): string {
  const dir = mkdtempSync(join(TMP_ROOT, 'pilot-attempt-'));
  made.push(dir);
  for (const s of rec.stages) {
    mkdirSync(join(dir, s.recordDir), { recursive: true });
    writeFileSync(join(dir, s.recordDir, 'stage.json'), JSON.stringify({ provider: 'openai', settings: { isolation: { mechanism } } }));
    writeFileSync(join(dir, s.recordDir, 'events.jsonl'), codexEvents(exit));
  }
  return dir;
}
const SHELL: ShellHealth = { attempted: 1, succeeded: 1, failed: 0, malformedLines: 0, firstFailure: null };

describe('toPilotAttempt', () => {
  it('copies the gate fields and takes each stage isolation from the supplied reader', () => {
    const rec = exercisedRecord();
    const p = toPilotAttempt(rec, (d) => (d.endsWith('review') ? 'bwrap' : null), (d) => (d.endsWith('review') ? null : SHELL));
    expect(p).toMatchObject({ conditionId: COND, attempt: 1, phase: 'finished', outcome: 'completed', activeMs: 180_000, evaluation: { status: 'passed', durationMs: 30_000 } });
    expect(p.stages.map((s) => s.isolationMechanism)).toEqual(rec.stages.map((s) => (s.recordDir.endsWith('review') ? 'bwrap' : null)));
    expect(p.stages.map((s) => s.shell)).toEqual(rec.stages.map((s) => (s.recordDir.endsWith('review') ? null : SHELL)));
    expect(p.stages.find((s) => s.handoff)?.handoff).toEqual({ kind: 'findings', status: 'ok', sha256: 'f'.repeat(64), file: 'handoffs/findings.md' });
  });

  describe('properties', () => {
    it('preserves stage order and ids for any subset of stages', () => {
      const all = exercisedRecord().stages;
      fc.assert(
        fc.property(fc.subarray(all), fc.option(fc.string(), { nil: null }), (stages, mech) => {
          const p = toPilotAttempt({ ...exercisedRecord(), stages }, () => mech, () => null);
          return p.stages.length === stages.length && p.stages.every((s, i) => s.id === stages[i]!.id && s.isolationMechanism === mech);
        }),
      );
    });
  });
});

describe('isolationReader', () => {
  it('returns the recorded mechanism, or null when stage.json is absent', () => {
    const rec = exercisedRecord();
    const dir = writeStageRecords(rec, 'sandbox-exec');
    expect(isolationReader(dir)(rec.stages[0]!.recordDir)).toBe('sandbox-exec');
    expect(isolationReader(dir)('stages/missing')).toBeNull();
  });
});

describe('shellReader', () => {
  it('reads shell health with the provider from stage.json, or null when a file or provider is missing', () => {
    const rec = exercisedRecord();
    const dir = writeStageRecords(rec, 'bwrap', 2);
    expect(shellReader(dir)(rec.stages[0]!.recordDir)).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(shellReader(dir)('stages/missing')).toBeNull();
    writeFileSync(join(dir, rec.stages[0]!.recordDir, 'stage.json'), JSON.stringify({ provider: 'other' }));
    expect(shellReader(dir)(rec.stages[0]!.recordDir)).toBeNull();
  });
});

describe('pilotLeftUnexercised', () => {
  const unexercised = pilotLeftUnexercised(LIMITS);

  it('is false for a pilot that ran every planned stage under OS isolation', () => {
    const rec = exercisedRecord();
    expect(unexercised(rec, writeStageRecords(rec, 'sandbox-exec'))).toBe(false);
  });

  it('is true for an early failure that never reached the later stages', () => {
    const rec = { ...exercisedRecord(), outcome: 'scored-failure' as const, termination: 'failed-required-handoff' as const, stages: exercisedRecord().stages.slice(0, 1) };
    expect(unexercised(rec, writeStageRecords(rec, 'sandbox-exec'))).toBe(true);
  });

  it('is true when every shell command in the write stages failed', () => {
    const rec = exercisedRecord();
    expect(unexercised(rec, writeStageRecords(rec, 'bwrap', 1))).toBe(true);
  });

  it('is true when the stages ran without OS isolation', () => {
    const rec = exercisedRecord();
    expect(unexercised(rec, writeStageRecords(rec, 'none'))).toBe(true);
  });
});
