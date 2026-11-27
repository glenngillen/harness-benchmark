import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { summarise, type Preflight } from '../../src/evaluator/verdict.ts';
import { BEHAVIOURS, type Behaviour, type CaseResult } from '../../src/evaluator/types.ts';

const catalogue = BEHAVIOURS.flatMap((b) => [1, 2].map((n) => ({ id: `${b}.c${n}`, behaviour: b as Behaviour, title: `${b} case ${n}` })));
const result = (id: string, passed: boolean): CaseResult => {
  const c = catalogue.find((x) => x.id === id)!;
  return { ...c, passed, detail: passed ? '' : 'nope', durationMs: 1 };
};
const all = (passed: boolean) => catalogue.map((c) => result(c.id, passed));
const base = { catalogue, preflight: 'ready' as Preflight, infrastructure: null, ceilingReached: false };

describe('summarise', () => {
  it('passes only when every catalogued case passed', () => {
    const s = summarise({ ...base, results: all(true) });
    expect(s.status).toBe('passed');
    expect(s.passedCases).toBe(16);
    expect(Object.values(s.behaviours).every((b) => b.passed && b.cases === 2)).toBe(true);
  });

  it('fails with per-behaviour diagnostics when any case fails', () => {
    const results = all(true).map((r) => (r.id === 'A5.c2' ? { ...r, passed: false } : r));
    const s = summarise({ ...base, results });
    expect(s.status).toBe('failed');
    expect(s.reason).toBe('cases-failed');
    expect(s.behaviours.A5).toEqual({ passed: false, cases: 2, passedCases: 1 });
    expect(s.behaviours.A4.passed).toBe(true);
  });

  it('fills cases that never reported as failed, so a short run cannot pass', () => {
    const s = summarise({ ...base, results: all(true).slice(0, 3) });
    expect(s.status).toBe('failed');
    expect(s.cases).toHaveLength(16);
    expect(s.cases[3]!.detail).toBe('not run');
  });

  it('rejects missing or unbuildable output without running cases', () => {
    for (const preflight of ['missing-output', 'build-failed', 'snapshot-too-large'] as const) {
      const s = summarise({ ...base, preflight, results: all(true) });
      expect(s.status).toBe('failed');
      expect(s.reason).toBe(preflight);
      expect(s.cases.every((c) => !c.passed && c.detail === `not run: ${preflight}`)).toBe(true);
    }
  });

  it('reports the ceiling as the reason when it was reached', () => {
    expect(summarise({ ...base, ceilingReached: true, results: all(false) }).reason).toBe('ceiling-reached');
  });

  it('marks infrastructure problems operational regardless of app outcome', () => {
    const s = summarise({ ...base, infrastructure: 'chromium failed to launch', results: all(true) });
    expect(s.status).toBe('infrastructure-failure');
    expect(s.reason).toBe('chromium failed to launch');
  });

  describe('properties', () => {
    it('keeps counts consistent and passes iff every case passed with no infrastructure problem', () => {
      fc.assert(
        fc.property(
          fc.subarray(catalogue.map((c) => c.id)),
          fc.func(fc.boolean()),
          fc.option(fc.string(), { nil: null }),
          fc.constantFrom<Preflight>('ready', 'missing-output', 'build-failed'),
          (ids, pass, infrastructure, preflight) => {
            const results = ids.map((id) => result(id, pass(id)));
            const s = summarise({ ...base, results, infrastructure, preflight });
            expect(s.totalCases).toBe(catalogue.length);
            expect(Object.values(s.behaviours).reduce((n, b) => n + b.cases, 0)).toBe(s.totalCases);
            expect(Object.values(s.behaviours).reduce((n, b) => n + b.passedCases, 0)).toBe(s.passedCases);
            expect(s.passedCases).toBeLessThanOrEqual(s.totalCases);
            const allPassed = preflight === 'ready' && ids.length === catalogue.length && results.every((r) => r.passed);
            expect(s.status === 'passed').toBe(infrastructure === null && allPassed);
            if (infrastructure !== null) expect(s.status).toBe('infrastructure-failure');
          },
        ),
      );
    });
  });
});
