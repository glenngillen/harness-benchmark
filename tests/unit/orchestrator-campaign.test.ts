import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BENCHMARK_ROOT } from '../../src/fixtures.ts';
import type { Supervised } from '../../src/evaluator/supervise.ts';
import { acquireLock, runCampaign, slotDir, type CampaignConfig, type CampaignDeps } from '../../src/orchestrator/campaign.ts';
import type { ScheduleSlot } from '../../src/orchestrator/schedule.ts';
import { pilotLeftUnexercised } from '../../src/freeze/pilot-attempt.ts';
import { attemptFile, readJson, writeJsonAtomic, type AttemptRecord, type WorkflowTermination } from '../../src/orchestrator/state.ts';
import type { WorkflowOutcome } from '../../src/orchestrator/workflow.ts';

const TMP_ROOT = process.env.HARNESS_TEST_TMP ?? join(BENCHMARK_ROOT, '.runs', 'unit-tmp');
mkdirSync(TMP_ROOT, { recursive: true });
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SLOTS: ScheduleSlot[] = [
  { block: 1, slot: 1, conditionId: 'solo.CF.off' },
  { block: 1, slot: 2, conditionId: 'pi.AF-CC.on' },
];

function setup(script: Array<WorkflowTermination | { termination: WorkflowTermination; noWorkspace?: boolean }>, verdicts: Array<Supervised['kind'] | 'passed' | 'failed'> = [], slots: ScheduleSlot[] = SLOTS) {
  const root = mkdtempSync(join(TMP_ROOT, 'campaign-'));
  made.push(root);
  const cfg: CampaignConfig = { label: 'cohort-03', slots, maxReplacements: 2, recordsRoot: join(root, 'records'), runtimeRoot: join(root, 'runtime'), outageBackoffMs: 1000 };
  let clock = Date.parse('2026-11-14T00:00:00Z');
  const calls: string[] = [];
  const slept: number[] = [];
  let i = 0;
  let v = 0;
  const deps: CampaignDeps = {
    now: () => clock,
    wallClock: () => new Date(clock),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    runAttempt: async (ctx) => {
      calls.push(`run:${ctx.slot.slot}:${ctx.attempt}`);
      const s = script[i++];
      if (s === undefined) throw new Error('unscripted attempt');
      const { termination, noWorkspace } = typeof s === 'string' ? { termination: s, noWorkspace: false } : s;
      const start = clock;
      clock += 10 * 60_000;
      const ws = join(ctx.runtimeDir, 'workspace');
      mkdirSync(ws, { recursive: true });
      return { termination, detail: null, startedAt: new Date(start).toISOString(), endedAt: new Date(clock).toISOString(), activeMs: clock - start, stages: [], results: [], sensorRepairs: 0, checkRuns: 0, finalWorkspace: noWorkspace ? null : ws } satisfies WorkflowOutcome;
    },
    freeze: (_ws, dest) => {
      mkdirSync(dest, { recursive: true });
      return 'snap-hash';
    },
    evaluate: async (o) => {
      calls.push('evaluate');
      clock += 60_000;
      const k = verdicts[v++] ?? 'passed';
      if (k === 'infrastructure-failure') return { kind: 'infrastructure-failure', reason: 'evaluator crashed', exitCode: 1, timedOut: false };
      mkdirSync(o.workDir, { recursive: true });
      writeFileSync(o.verdictPath, '{}');
      return { kind: 'verdict', exitCode: 0, verdict: { status: k, durationMs: 42_000, snapshot: { hash: 'snap-hash' }, reason: k } } as unknown as Supervised;
    },
    copyFile: (from, to) => writeFileSync(to, readFileSync(from)),
  };
  const rec = (s: ScheduleSlot, n: number) => readJson<AttemptRecord & Record<string, unknown>>(attemptFile(join(slotDir(cfg, s), `attempt-${n}`)))!;
  const advance = (ms: number) => (clock += ms);
  return { cfg, deps, calls, slept, rec, advance, run: () => runCampaign(cfg, deps) };
}

describe('runCampaign', () => {
  it('runs each slot once, freezes, evaluates, and records acceptance', async () => {
    const h = setup(['completed', 'repair-budget-exhausted'], ['passed', 'passed']);
    expect(await h.run()).toEqual({ status: 'complete', slots: 2 });
    expect(h.calls).toEqual(['run:1:1', 'evaluate', 'run:2:1', 'evaluate']);
    expect(h.rec(SLOTS[0]!, 1)).toMatchObject({ phase: 'finished', outcome: 'completed', accepted: true, finalSnapshotHash: 'snap-hash', evaluation: { status: 'passed', verdictFile: 'verdict.json', durationMs: 42_000 } });
    // A scored failure is evaluated descriptively but never accepted, and never retried.
    expect(h.rec(SLOTS[1]!, 2 - 1)).toMatchObject({ outcome: 'scored-failure', accepted: false });
    expect(existsSync(join(slotDir(h.cfg, SLOTS[0]!), 'attempt-1', 'verdict.json'))).toBe(true);
  });

  it('records the operating environment on each attempt when supplied, and survives the final rewrite', async () => {
    const h = setup(['completed', 'completed']);
    let n = 0;
    h.deps.environment = () => ({ os: { platform: 'darwin' }, call: ++n });
    await h.run();
    expect(h.rec(SLOTS[0]!, 1)).toMatchObject({ phase: 'finished', environment: { os: { platform: 'darwin' }, call: 1 } });
    expect(h.rec(SLOTS[1]!, 1).environment).toEqual({ os: { platform: 'darwin' }, call: 2 });
  });

  it('is idempotent: rerunning a complete campaign starts nothing', async () => {
    const h = setup(['completed', 'completed']);
    await h.run();
    const n = h.calls.length;
    expect(await h.run()).toEqual({ status: 'complete', slots: 2 });
    expect(h.calls).toHaveLength(n);
  });

  it('a completed workflow whose evaluation fails is not accepted', async () => {
    const h = setup(['completed', 'completed'], ['failed', 'passed']);
    await h.run();
    expect(h.rec(SLOTS[0]!, 1)).toMatchObject({ outcome: 'completed', accepted: false });
  });

  it('no implementation snapshot: scored failure is rejected without evaluation', async () => {
    const h = setup([{ termination: 'failed-required-handoff', noWorkspace: true }, 'completed']);
    await h.run();
    expect(h.calls.slice(0, 2)).toEqual(['run:1:1', 'run:2:1']);
    expect(h.rec(SLOTS[0]!, 1)).toMatchObject({ outcome: 'scored-failure', accepted: false, evaluation: { status: 'not-run', reason: 'no implementation snapshot' } });
  });

  it('after a runner crash mid-attempt, closes it as operational and starts a linked replacement', async () => {
    const h = setup(['completed', 'completed']);
    const dir = join(slotDir(h.cfg, SLOTS[0]!), 'attempt-1');
    writeJsonAtomic(attemptFile(dir), { schema: 'harness-benchmark/attempt@1', phase: 'running', attempt: 1, endedAt: null, termination: null });
    await h.run();
    expect(h.rec(SLOTS[0]!, 1)).toMatchObject({ phase: 'finished', outcome: 'operational', termination: 'runner-infrastructure-failure', terminationDetail: 'runner-interrupted' });
    expect(h.rec(SLOTS[0]!, 2)).toMatchObject({ replaces: 1, waitReason: 'runner-interrupted', outcome: 'completed' });
    expect(h.slept).toEqual([]);
  });

  it('resumes a pending evaluation without rerunning the workflow', async () => {
    const h = setup(['completed', 'completed', 'completed'], ['infrastructure-failure']);
    // First run: slot 1 completes but evaluation infrastructure fails -> operational, replaced.
    const r = await h.run();
    expect(r.status).toBe('complete');
    expect(h.rec(SLOTS[0]!, 1)).toMatchObject({ outcome: 'operational', termination: 'evaluator-infrastructure-failure', scoredTerminationBeforeEvaluation: 'completed' });
    expect(h.rec(SLOTS[0]!, 2)).toMatchObject({ replaces: 1, outcome: 'completed' });
    expect(h.slept).toEqual([1000]);

    const g = setup(['completed']);
    g.cfg.slots = [SLOTS[0]!];
    const dir = join(slotDir(g.cfg, SLOTS[0]!), 'attempt-1');
    mkdirSync(join(g.cfg.runtimeRoot, 'block-01', 'slot-01-solo.CF.off', 'attempt-1', 'final'), { recursive: true });
    writeJsonAtomic(attemptFile(dir), { schema: 'harness-benchmark/attempt@1', phase: 'awaiting-evaluation', attempt: 1, termination: 'completed', finalSnapshotHash: 'snap-hash', endedAt: '2026-11-14T00:00:00Z' });
    await g.run();
    expect(g.calls).toEqual(['evaluate']);
    expect(g.rec(SLOTS[0]!, 1)).toMatchObject({ phase: 'finished', accepted: true });
  });

  it('pauses on quota exhaustion; the next invocation starts the linked replacement and records the wait', async () => {
    const h = setup(['quota-exhausted', 'completed', 'completed']);
    expect(await h.run()).toMatchObject({ status: 'paused', reason: 'quota-exhausted', attempt: 1 });
    expect(h.calls).toEqual(['run:1:1']);
    h.advance(3 * 3600_000);
    expect(await h.run()).toEqual({ status: 'complete', slots: 2 });
    expect(h.rec(SLOTS[0]!, 2)).toMatchObject({ replaces: 1, waitReason: 'quota-exhausted', waitBeforeMs: 3 * 3600_000 });
  });

  it('backs off in process for an outage, and pauses the block when replacements are exhausted', async () => {
    const h = setup(['provider-outage', 'provider-outage', 'provider-outage']);
    expect(await h.run()).toMatchObject({ status: 'paused', reason: 'replacements-exhausted' });
    expect(h.calls).toEqual(['run:1:1', 'run:1:2', 'run:1:3']);
    expect(h.slept).toEqual([1000, 1000]);
    expect(h.rec(SLOTS[0]!, 3)).toMatchObject({ replaces: 2, outcome: 'operational' });
    // Still paused on rerun; slot 2 never starts.
    expect(await h.run()).toMatchObject({ status: 'paused', reason: 'replacements-exhausted' });
    expect(h.calls).toHaveLength(3);
  });

  it('logs every campaign event to an append-only log', async () => {
    const h = setup(['completed', 'completed']);
    await h.run();
    const types = readFileSync(join(h.cfg.recordsRoot, 'campaign-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
    expect(types[0]).toBe('campaign-started');
    expect(types.at(-1)).toBe('campaign-complete');
    expect(types.filter((t) => t === 'attempt-started')).toHaveLength(2);
  });
});

const PILOT: ScheduleSlot[] = [{ block: 0, slot: 1, conditionId: 'irf.CC-AF-CC.off' }];
const LIMITS = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'config', 'limits.json'), 'utf8'));
const earlyFailure = { termination: 'failed-required-handoff' as const, noWorkspace: true };

describe('runCampaign pilot retry', () => {
  it('without the retry option, rerunning leaves an early finished pilot failure as the only attempt', async () => {
    const h = setup([earlyFailure], [], PILOT);
    await h.run();
    expect(await h.run()).toEqual({ status: 'complete', slots: 1 });
    expect(h.calls).toEqual(['run:1:1']);
  });

  it('the documented recovery starts a fresh, linked attempt and keeps the early failure untouched', async () => {
    const h = setup([earlyFailure, 'completed'], ['passed'], PILOT);
    await h.run();
    const first = readFileSync(attemptFile(join(slotDir(h.cfg, PILOT[0]!), 'attempt-1')), 'utf8');
    expect(h.rec(PILOT[0]!, 1)).toMatchObject({ outcome: 'scored-failure', stages: [] });
    // The real predicate: the freeze gate's exercise test against the runner's stage plan.
    h.cfg.pilotRetry = { unexercised: pilotLeftUnexercised(LIMITS) };
    h.advance(60_000);
    expect(await h.run()).toEqual({ status: 'complete', slots: 1 });
    expect(h.calls).toEqual(['run:1:1', 'run:1:2', 'evaluate']);
    expect(readFileSync(attemptFile(join(slotDir(h.cfg, PILOT[0]!), 'attempt-1')), 'utf8')).toBe(first);
    expect(h.rec(PILOT[0]!, 2)).toMatchObject({ attempt: 2, pilotRetryOf: 1, replaces: null, waitReason: 'pilot-retry-unexercised', waitBeforeMs: 60_000, outcome: 'completed' });
  });

  it('starts at most one retry per slot per invocation, so a pilot that keeps failing early cannot loop', async () => {
    const h = setup([earlyFailure, earlyFailure, earlyFailure], [], PILOT);
    h.cfg.pilotRetry = { unexercised: () => true };
    await h.run();
    expect(h.calls).toEqual(['run:1:1']);
    await h.run();
    expect(h.calls).toEqual(['run:1:1', 'run:1:2']);
    await h.run();
    expect(h.rec(PILOT[0]!, 3)).toMatchObject({ pilotRetryOf: 2, outcome: 'scored-failure' });
  });

  it('does not retry once any finished pilot exercised the configuration', async () => {
    const h = setup(['completed'], ['passed'], PILOT);
    h.cfg.pilotRetry = { unexercised: () => false };
    await h.run();
    await h.run();
    expect(h.calls).toEqual(['run:1:1', 'evaluate']);
  });

  it('never retries a scored failure in a scored block, even with the option set', async () => {
    const h = setup([earlyFailure, 'completed', 'completed'], [], SLOTS);
    h.cfg.pilotRetry = { unexercised: () => true };
    await h.run();
    await h.run();
    expect(h.calls).toEqual(['run:1:1', 'run:2:1', 'evaluate']);
  });

  it('a retry gets its own operational replacement budget', async () => {
    const h = setup([earlyFailure, 'provider-outage', 'provider-outage', 'completed'], ['passed'], PILOT);
    h.cfg.pilotRetry = { unexercised: () => true };
    await h.run();
    expect(await h.run()).toEqual({ status: 'complete', slots: 1 });
    expect(h.rec(PILOT[0]!, 2)).toMatchObject({ pilotRetryOf: 1, outcome: 'operational' });
    expect(h.rec(PILOT[0]!, 4)).toMatchObject({ replaces: 3, outcome: 'completed' });
  });
});

describe('runCampaign quota audit refill', () => {
  const ONE = [SLOTS[0]!];
  /** Overlay that reclassifies the given attempts of slot 1 as quota-exhausted, as applyAudit does. */
  const reclassify = (attempts: number[]) => (r: AttemptRecord): AttemptRecord =>
    r.slot === 1 && attempts.includes(r.attempt) && r.outcome === 'scored-failure' ? { ...r, termination: 'quota-exhausted', outcome: 'operational', accepted: null } : r;

  it('without a decision the scored failure stands and the slot is done', async () => {
    const h = setup(['task-timeout'], [], ONE);
    expect(await h.run()).toEqual({ status: 'complete', slots: 1 });
    h.cfg.effectiveRecord = reclassify([]);
    expect(await h.run()).toEqual({ status: 'complete', slots: 1 });
    expect(h.calls).toEqual(['run:1:1', 'evaluate']);
  });

  it('a reclassified attempt is refilled from a fresh workspace, linked by replaces, and its record is untouched', async () => {
    const h = setup(['task-timeout', 'completed'], [], ONE);
    await h.run();
    const before = readFileSync(attemptFile(join(slotDir(h.cfg, ONE[0]!), 'attempt-1')), 'utf8');
    h.advance(3600_000);
    h.cfg.effectiveRecord = reclassify([1]);
    expect(await h.run()).toEqual({ status: 'complete', slots: 1 });
    expect(h.calls).toEqual(['run:1:1', 'evaluate', 'run:1:2', 'evaluate']);
    expect(h.rec(ONE[0]!, 2)).toMatchObject({ replaces: 1, waitReason: 'quota-exhausted', outcome: 'completed' });
    expect(readFileSync(attemptFile(join(slotDir(h.cfg, ONE[0]!), 'attempt-1')), 'utf8')).toBe(before);
  });

  it('property: the refill respects the replacement budget (the reclassified attempt counts as operational)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3 }), async (outages) => {
        const h = setup([...Array<WorkflowTermination>(outages).fill('provider-outage'), 'task-timeout', 'completed'], [], ONE);
        const first = await h.run();
        if (outages > h.cfg.maxReplacements) {
          // The budget ran out before any scored attempt: nothing to reclassify.
          expect(first).toMatchObject({ status: 'paused', reason: 'replacements-exhausted' });
          return;
        }
        expect(first).toEqual({ status: 'complete', slots: 1 });
        const scored = outages + 1;
        h.cfg.effectiveRecord = reclassify([scored]);
        const second = await h.run();
        const started = h.calls.filter((c) => c.startsWith('run:')).length;
        if (scored <= h.cfg.maxReplacements) {
          expect(second).toEqual({ status: 'complete', slots: 1 });
          expect(started).toBe(scored + 1);
          expect(h.rec(ONE[0]!, scored + 1)).toMatchObject({ replaces: scored });
        } else {
          expect(second).toMatchObject({ status: 'paused', reason: 'replacements-exhausted' });
          expect(started).toBe(scored);
        }
        expect(started).toBeLessThanOrEqual(1 + h.cfg.maxReplacements);
      }),
      { numRuns: 12 },
    );
  });
});

describe('acquireLock', () => {
  it('refuses a second live runner and clears a stale lock', () => {
    const root = mkdtempSync(join(TMP_ROOT, 'lock-'));
    made.push(root);
    const path = join(root, 'campaign.lock');
    const events: string[] = [];
    const release = acquireLock(path, (t) => events.push(t));
    expect(() => acquireLock(path, () => {}, () => true)).toThrow(/another runner/);
    release();
    writeFileSync(path, '999999');
    const r2 = acquireLock(path, (t) => events.push(t), () => false);
    expect(events).toEqual(['stale-lock-cleared']);
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid));
    r2();
    expect(existsSync(path)).toBe(false);
  });
});
