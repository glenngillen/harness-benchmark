import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { runChecks, type Check } from '../../fixtures/scaffold/checks/core.ts';
import { SMOKE_CHECKS } from '../../fixtures/scaffold/checks/smoke.ts';
import { CONTRACT_CHECKS } from '../../fixtures/scaffold/checks/contract.ts';
import { lastLines, parseArgs } from '../../fixtures/scaffold/checks/cli.ts';
import { CASES } from '../../src/evaluator/cases.ts';
import { createSimulation, type SimFault } from './support/sim-app.ts';

async function runSuite(checks: readonly Check[], faults: SimFault[] = [], budgetMs = 60_000) {
  const sim = createSimulation(faults);
  await sim.app.start();
  const t0 = sim.clock.now();
  const results = await runChecks(checks, { http: sim.http, clock: sim.clock, deadlineAt: t0 + budgetMs });
  return { results, failing: results.filter((r) => !r.passed).map((r) => r.name), elapsed: sim.clock.now() - t0 };
}

describe('public build-time check suites against the simulated app', () => {
  it('pass the correct behaviour well inside their budgets', async () => {
    const smoke = await runSuite(SMOKE_CHECKS, [], 30_000);
    const contract = await runSuite(CONTRACT_CHECKS);
    expect(smoke.failing).toEqual([]);
    expect(contract.failing).toEqual([]);
    expect(contract.results.every((r) => r.detail === '')).toBe(true);
    expect(contract.elapsed).toBeLessThan(20_000);
  });

  // Build-time checks cover submission, validation, completion, retry and idempotency on disclosed
  // examples only. Persistence (A7), the browser page (A8) and steps above 20 (A4) are left to the
  // independent evaluator, so those faults pass every build-time check by design.
  const expected: Record<string, string[]> = {
    'A1-worker-never-healthy': ['smoke.worker-up'],
    'A2-job-response-missing-id': ['contract.submit-job', 'contract.complete-job', 'contract.retry-transient', 'contract.idempotent-replay'],
    'A3-wrong-output': ['contract.complete-job', 'contract.retry-transient'],
    'A4-steps-unbounded': [],
    'A5-idempotency-ignores-payload': ['contract.idempotent-replay'],
    'A6-no-retry': ['contract.retry-transient'],
    'A7-no-crash-recovery': [],
    'A8-ui-hides-errors': [],
  };
  for (const [fault, names] of Object.entries(expected)) {
    it(`${fault} fails ${names.length ? names.join(', ') : 'no build-time check'}`, async () => {
      const smoke = await runSuite(SMOKE_CHECKS, [fault as SimFault], 30_000);
      const contract = await runSuite(CONTRACT_CHECKS, [fault as SimFault]);
      expect([...smoke.failing, ...contract.failing]).toEqual(names);
    });
  }

  it('fails every check, with actionable detail, when the server never starts', async () => {
    const smoke = await runSuite(SMOKE_CHECKS, ['server-never-starts'], 30_000);
    const contract = await runSuite(CONTRACT_CHECKS, ['server-never-starts']);
    expect([...smoke.results, ...contract.results].every((r) => !r.passed)).toBe(true);
    expect(smoke.results[0]!.detail).toMatch(/timed out after 10000 ms waiting for GET \/health.*unreachable/);
    expect(contract.elapsed).toBeLessThan(60_000);
  });

  it('report expected versus observed values on disclosed data', async () => {
    const { results } = await runSuite(CONTRACT_CHECKS, ['A6-no-retry']);
    const retry = results.find((r) => r.name === 'contract.retry-transient')!;
    expect(retry.detail).toBe('finished job status: expected "completed", observed "failed"');
  });

  it('stop running checks once the suite budget is spent', async () => {
    const { results } = await runSuite(SMOKE_CHECKS, ['server-never-starts'], 1);
    expect(results[0]!.passed).toBe(false);
    expect(results.slice(1).every((r) => r.detail === 'not run: check time limit reached')).toBe(true);
  });

  it('use different data from every independent evaluator case', () => {
    const publicText = JSON.stringify([...SMOKE_CHECKS, ...CONTRACT_CHECKS].map((c) => c.run.toString()));
    for (const input of ['Check example', 'complete me', 'retry example', 'idempotent example', 'check-example-key']) expect(publicText).toContain(input);
    expect(publicText).not.toMatch(/eval-|Zebra|Quarterly|nonce/);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const c of [...SMOKE_CHECKS, ...CONTRACT_CHECKS]) expect(CASES.some((e) => e.id === c.name)).toBe(false);
  });
});

describe('check CLI helpers', () => {
  it('parses the suite and optional report path', () => {
    expect(parseArgs(['smoke'])).toEqual({ suite: 'smoke', report: undefined });
    expect(parseArgs(['contract', '--report', '/r.json'])).toEqual({ suite: 'contract', report: '/r.json' });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['evaluate'])).toThrow(/usage/);
    expect(() => parseArgs(['smoke', '--verbose'])).toThrow(/unknown argument/);
  });

  describe('properties', () => {
    it('lastLines keeps at most n lines, each at most 301 characters, ending with the input tail', () => {
      fc.assert(
        fc.property(fc.array(fc.string({ maxLength: 400 }).map((s) => s.replace(/[\r\n]/g, '')), { maxLength: 80 }), fc.integer({ min: 1, max: 60 }), (lines, n) => {
          const out = lastLines(lines.join('\n'), n);
          expect(out.length).toBeLessThanOrEqual(n);
          expect(out.every((l) => l.length <= 301)).toBe(true);
          // A single trailing newline (an empty last element) is not a line.
          const kept = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
          expect(out.length).toBe(Math.min(n, kept.length));
          if (out.length > 0) expect(kept.at(-1)!.startsWith(out.at(-1)!.replace(/…$/, ''))).toBe(true);
        }),
      );
    });
  });
});
