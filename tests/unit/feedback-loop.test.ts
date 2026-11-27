import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decide, runFeedbackLoop, type LoopDeps, type LoopInput } from '../../src/feedback/loop.ts';
import type { CheckRun } from '../../src/feedback/types.ts';

function checkRun(status: CheckRun['status']): CheckRun {
  const failed = status === 'failed';
  return {
    schema: 'harness-benchmark/check-run@1',
    status,
    reason: status === 'infrastructure-failure' ? 'no sandbox' : null,
    startedAt: '2026-11-14T00:00:00.000Z',
    durationMs: 5_000,
    ceilingMs: 120_000,
    snapshotHash: 'h',
    fixedFileChanges: [],
    suites: [
      { suite: 'build', status: 'passed', checks: [{ name: 'build.compile', title: 't', passed: true, detail: '' }], output: [], stderr: { server: [], worker: [] }, durationMs: 1 },
      { suite: 'smoke', status: 'passed', checks: [], output: [], stderr: { server: [], worker: [] }, durationMs: 1 },
      {
        suite: 'contract',
        status: failed ? 'failed' : 'passed',
        checks: [{ name: 'contract.retry-transient', title: 't', passed: !failed, detail: failed ? 'attempts: expected 2, observed 1' : '' }],
        output: [],
        stderr: { server: [], worker: [] },
        durationMs: 1,
      },
    ],
  };
}

const MIN = 60_000;
const base = { position: 'final' as const, repairsUsed: 0, maxRepairs: 2, stageRemainingMs: 10 * MIN, workflowRemainingMs: 20 * MIN };

describe('decide', () => {
  it('proceeds on a pass', () => {
    expect(decide({ ...base, run: 'passed' })).toEqual({ action: 'proceed' });
  });

  it('repairs a failure while repairs and stage time remain', () => {
    expect(decide({ ...base, run: 'failed' })).toEqual({ action: 'repair', repairsLeftAfter: 1 });
    expect(decide({ ...base, run: 'failed', repairsUsed: 1 })).toEqual({ action: 'repair', repairsLeftAfter: 0 });
  });

  it('gates the final stage: no repairs left is repair-budget-exhausted, no stage time is a stage timeout', () => {
    expect(decide({ ...base, run: 'failed', repairsUsed: 2 })).toEqual({ action: 'terminate', termination: 'repair-budget-exhausted' });
    expect(decide({ ...base, run: 'failed', stageRemainingMs: 0 })).toEqual({ action: 'terminate', termination: 'stage-timeout' });
  });

  it('lets an intermediate stage continue to its scheduled review with failing checks', () => {
    expect(decide({ ...base, position: 'intermediate', run: 'failed', repairsUsed: 2 })).toEqual({ action: 'continue-failing', reason: 'repairs-exhausted' });
    expect(decide({ ...base, position: 'intermediate', run: 'failed', stageRemainingMs: -1 })).toEqual({ action: 'continue-failing', reason: 'stage-time-exhausted' });
  });

  it('ends at the workflow ceiling and on check infrastructure failure', () => {
    expect(decide({ ...base, position: 'intermediate', run: 'failed', workflowRemainingMs: 0 })).toEqual({ action: 'terminate', termination: 'task-timeout' });
    expect(decide({ ...base, run: 'infrastructure-failure' })).toEqual({ action: 'terminate', termination: 'runner-infrastructure-failure' });
  });

  describe('properties', () => {
    it('never grants a repair beyond the per-workflow cap or without stage time', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('passed', 'failed', 'infrastructure-failure' as const),
          fc.constantFrom('intermediate', 'final' as const),
          fc.integer({ min: 0, max: 5 }),
          fc.integer({ min: 0, max: 3 }),
          fc.integer({ min: -MIN, max: 30 * MIN }),
          fc.integer({ min: -MIN, max: 30 * MIN }),
          (r, position, repairsUsed, maxRepairs, stageRemainingMs, workflowRemainingMs) => {
            const d = decide({ run: r as CheckRun['status'], position: position as 'final', repairsUsed, maxRepairs, stageRemainingMs, workflowRemainingMs });
            if (d.action === 'repair') {
              expect(repairsUsed).toBeLessThan(maxRepairs);
              expect(stageRemainingMs).toBeGreaterThan(0);
              expect(d.repairsLeftAfter).toBe(maxRepairs - repairsUsed - 1);
            }
            if (r === 'passed') expect(d.action).toBe('proceed');
            if (position === 'intermediate' && d.action === 'terminate') expect(['task-timeout', 'runner-infrastructure-failure']).toContain(d.termination);
          },
        ),
      );
    });
  });
});

// ------------------------------------------------------------------ driver

function harness(results: CheckRun['status'][], repairOutcomes: Array<{ kind: 'returned' } | { kind: 'ended'; termination: string }> = [], repairCostMs = 3 * MIN) {
  let t = 0;
  const calls: { checks: number[]; prompts: string[]; deadlines: number[] } = { checks: [], prompts: [], deadlines: [] };
  const deps: LoopDeps = {
    now: () => t,
    wallClock: () => new Date(Date.UTC(2026, 10, 14) + t),
    async runChecks(timeoutMs) {
      calls.checks.push(timeoutMs);
      const status = results.shift() ?? 'passed';
      t += 5_000;
      return checkRun(status);
    },
    async repair(prompt, ctx) {
      calls.prompts.push(prompt);
      calls.deadlines.push(ctx.deadlineAt);
      t += repairCostMs;
      return repairOutcomes.shift() ?? { kind: 'returned' };
    },
    repairTemplate: 'Fix this:\n{{FEEDBACK}}\nRepairs remaining after this one: {{REPAIRS_LEFT}}.',
  };
  return { deps, calls, advance: (ms: number) => (t += ms) };
}

const input = (o: Partial<LoopInput> = {}): LoopInput => ({
  checkCondition: 'on',
  position: 'final',
  repairsUsed: 0,
  maxRepairs: 2,
  stageDeadlineAt: 10 * MIN,
  workflowDeadlineAt: 30 * MIN,
  checkCeilingMs: 120_000,
  feedbackMaxBytes: 4_000,
  ...o,
});

describe('runFeedbackLoop', () => {
  it('runs nothing and sends nothing when checks are off', async () => {
    const h = harness(['failed']);
    const r = await runFeedbackLoop(input({ checkCondition: 'off' }), h.deps);
    expect(r).toMatchObject({ outcome: 'proceed', termination: null, repairsUsed: 0, lastRun: null, events: [] });
    expect(h.calls.checks).toEqual([]);
    expect(h.calls.prompts).toEqual([]);
  });

  it('stops on the first pass without a repair', async () => {
    const h = harness(['passed']);
    const r = await runFeedbackLoop(input(), h.deps);
    expect(r).toMatchObject({ outcome: 'proceed', repairsUsed: 0 });
    expect(r.events.map((e) => e.type)).toEqual(['checks']);
    expect(h.calls.checks).toEqual([120_000]);
  });

  it('repairs, re-checks after each repair, and stops on a pass', async () => {
    const h = harness(['failed', 'passed']);
    const r = await runFeedbackLoop(input(), h.deps);
    expect(r).toMatchObject({ outcome: 'proceed', repairsUsed: 1 });
    expect(r.events.map((e) => e.type)).toEqual(['checks', 'repair', 'checks']);
    expect(h.calls.prompts[0]).toContain('[contract] contract.retry-transient: FAILED');
    expect(h.calls.prompts[0]).toContain('Repairs remaining after this one: 1.');
    expect(h.calls.deadlines[0]).toBe(10 * MIN);
  });

  it('ends the final stage as repair-budget-exhausted after two failed repairs', async () => {
    const h = harness(['failed', 'failed', 'failed']);
    const r = await runFeedbackLoop(input(), h.deps);
    expect(r).toMatchObject({ outcome: 'terminate', termination: 'repair-budget-exhausted', repairsUsed: 2 });
    expect(h.calls.prompts).toHaveLength(2);
    expect(r.lastRun?.status).toBe('failed');
  });

  it('shares the two-repair cap across stages', async () => {
    const h = harness(['failed', 'failed']);
    const r = await runFeedbackLoop(input({ repairsUsed: 1 }), h.deps);
    expect(r).toMatchObject({ outcome: 'terminate', termination: 'repair-budget-exhausted', repairsUsed: 2 });
    expect(h.calls.prompts).toHaveLength(1);
    expect(h.calls.prompts[0]).toContain('Repairs remaining after this one: 0.');
  });

  it('continues an intermediate stage with failing checks once repairs run out', async () => {
    const h = harness(['failed', 'failed', 'failed']);
    const r = await runFeedbackLoop(input({ position: 'intermediate' }), h.deps);
    expect(r).toMatchObject({ outcome: 'continue-failing', termination: null, repairsUsed: 2 });
  });

  it('passes a repair that ends the stage (for example a stage timeout) straight through', async () => {
    const h = harness(['failed'], [{ kind: 'ended', termination: 'stage-timeout' }]);
    const r = await runFeedbackLoop(input(), h.deps);
    expect(r).toMatchObject({ outcome: 'terminate', termination: 'stage-timeout', repairsUsed: 1 });
    expect(r.events.at(-1)).toMatchObject({ type: 'repair', outcome: { kind: 'ended', termination: 'stage-timeout' } });
  });

  it('clips the check ceiling to the workflow clock and ends at the workflow ceiling', async () => {
    const h = harness(['failed']);
    h.advance(30 * MIN - 60_000);
    const r = await runFeedbackLoop(input({ stageDeadlineAt: 40 * MIN }), h.deps);
    expect(h.calls.checks).toEqual([60_000]);
    expect(r).toMatchObject({ outcome: 'terminate', termination: 'task-timeout', repairsUsed: 1 });
    const late = harness([]);
    late.advance(30 * MIN);
    const r2 = await runFeedbackLoop(input(), late.deps);
    expect(r2).toMatchObject({ outcome: 'terminate', termination: 'task-timeout' });
    expect(late.calls.checks).toEqual([]);
  });

  it('records feedback text, its size and the stage minutes left with each repair', async () => {
    const h = harness(['failed', 'passed']);
    const r = await runFeedbackLoop(input(), h.deps);
    const repair = r.events.find((e) => e.type === 'repair')!;
    expect(repair).toMatchObject({ type: 'repair', index: 1, repairsLeftAfter: 1 });
    if (repair.type !== 'repair') throw new Error('unreachable');
    expect(repair.feedbackBytes).toBe(Buffer.byteLength(repair.feedback));
    expect(repair.feedback).toContain('Stage minutes remaining: 9.9');
  });

  it('treats check infrastructure failure as operational', async () => {
    const h = harness(['infrastructure-failure']);
    const r = await runFeedbackLoop(input(), h.deps);
    expect(r).toMatchObject({ outcome: 'terminate', termination: 'runner-infrastructure-failure', repairsUsed: 0 });
  });
});
