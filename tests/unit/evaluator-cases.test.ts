import { describe, expect, it } from 'vitest';
import { CASES, evaluationData, jobWindowMs } from '../../src/evaluator/cases.ts';
import { createCaseContext, runCases } from '../../src/evaluator/run.ts';
import { BEHAVIOURS, type Behaviour } from '../../src/evaluator/types.ts';
import { createSimulation, type SimFault } from './support/sim-app.ts';

const CEILING_MS = 120_000;

async function evaluateSim(faults: SimFault[] = [], ceilingMs = CEILING_MS) {
  const sim = createSimulation(faults);
  const ctx = createCaseContext({
    http: sim.http,
    app: sim.app,
    clock: sim.clock,
    browser: sim.browser,
    data: evaluationData('0123abcd'),
    deadlineAt: sim.clock.now() + ceilingMs,
  });
  const t0 = sim.clock.now();
  const run = await runCases(CASES, ctx);
  const failing = [...new Set(run.results.filter((r) => !r.passed).map((r) => r.behaviour))].sort();
  return { run, failing, elapsed: sim.clock.now() - t0, sim };
}

describe('evaluator cases against the simulated app', () => {
  it('declares unique case ids covering every behaviour', () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BEHAVIOURS) expect(CASES.some((c) => c.behaviour === b)).toBe(true);
    for (const c of CASES) expect(c.id.startsWith(`${c.behaviour}.`)).toBe(true);
  });

  it('passes every case for the correct behaviour, well inside the ceiling', async () => {
    const { run, elapsed } = await evaluateSim();
    expect(run.results.filter((r) => !r.passed)).toEqual([]);
    expect(run.infrastructure).toBeNull();
    expect(run.ceilingReached).toBe(false);
    expect(elapsed).toBeLessThan(60_000);
  });

  // Each emulated broken reference fails its own behaviour. Collateral failures are listed
  // explicitly so a change in discrimination is visible in review.
  const expected: Record<string, Behaviour[]> = {
    'A1-worker-never-healthy': ['A1'],
    'A2-job-response-missing-id': ['A2', 'A3', 'A8'],
    'A3-wrong-output': ['A3', 'A6', 'A7'],
    'A4-steps-unbounded': ['A4'],
    'A5-idempotency-ignores-payload': ['A5'],
    'A6-no-retry': ['A6'],
    'A7-no-crash-recovery': ['A7'],
    'A8-ui-hides-errors': ['A8'],
  };
  for (const [fault, behaviours] of Object.entries(expected)) {
    it(`rejects ${fault} on ${behaviours.join(', ')}`, async () => {
      const { run, failing } = await evaluateSim([fault as SimFault]);
      expect(run.infrastructure).toBeNull();
      expect(failing).toEqual(behaviours);
    });
  }

  it('fails every case quickly when the server never starts', async () => {
    const { run, elapsed } = await evaluateSim(['server-never-starts']);
    expect(run.results.every((r) => !r.passed)).toBe(true);
    expect(run.infrastructure).toBeNull();
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it('fails A1 when the processes ignore SIGTERM', async () => {
    const { failing } = await evaluateSim(['ignores-sigterm']);
    expect(failing).toEqual(['A1']);
  });

  it('treats a browser that cannot launch as an infrastructure failure, not a rejection', async () => {
    const { run } = await evaluateSim(['browser-unavailable']);
    expect(run.infrastructure).toMatch(/chromium failed to launch/);
    const first = run.results.findIndex((r) => r.detail.startsWith('infrastructure:'));
    expect(run.results[first]!.id).toBe('A8.page-structure');
    expect(run.results.slice(first + 1).every((r) => r.detail === 'not run: evaluator infrastructure failure')).toBe(true);
  });

  it('marks the remaining cases not run once the ceiling is reached', async () => {
    const { run, elapsed } = await evaluateSim([], 5_000);
    expect(run.ceilingReached).toBe(true);
    expect(run.results).toHaveLength(CASES.length);
    expect(run.results.at(-1)!.detail).toBe('not run: evaluation ceiling reached');
    expect(elapsed).toBeLessThanOrEqual(5_000 + 100);
  });
});

describe('jobWindowMs', () => {
  it('grows with steps and caps retries at two', () => {
    expect(jobWindowMs(1)).toBe(1_000 + 500 + 1_000);
    expect(jobWindowMs(2, 2)).toBe(1_000 + 2 * 500 * 3 + 2 * 2_000 + 1_000);
    expect(jobWindowMs(2, 5)).toBe(jobWindowMs(2, 2));
  });
});

describe('evaluationData', () => {
  it('rejects nonces that would make invalid idempotency keys', () => {
    expect(() => evaluationData('NOT HEX')).toThrow(/invalid nonce/);
    const d = evaluationData('deadbeef');
    expect(d.longInput).toHaveLength(1000);
    for (const k of Object.values(d.keys)) expect(k).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});
