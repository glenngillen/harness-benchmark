import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { bootstrapCostPerAccepted, conditionStream, fnv1a32, quantile7, summarise, wilson } from '../../src/analysis/stats.ts';

describe('wilson', () => {
  it('matches published 95% values', () => {
    // k=5, n=10: 0.2366 – 0.7634
    const w = wilson(5, 10);
    expect(w.lower).toBeCloseTo(0.2366, 4);
    expect(w.upper).toBeCloseTo(0.7634, 4);
    expect(w.estimate).toBe(0.5);
  });
  it('keeps zero and full acceptance inside [0, 1] with a non-degenerate interval', () => {
    const z = wilson(0, 10);
    expect(z.lower).toBe(0);
    expect(z.upper).toBeCloseTo(0.2775, 4);
    const f = wilson(10, 10);
    expect(f.upper).toBe(1);
    expect(f.lower).toBeCloseTo(0.7225, 4);
  });
  it('is undefined for n = 0', () => {
    expect(wilson(0, 0)).toEqual({ estimate: null, lower: null, upper: null });
  });
  it('rejects impossible counts', () => {
    expect(() => wilson(3, 2)).toThrow();
    expect(() => wilson(-1, 2)).toThrow();
    expect(() => wilson(1.5, 2)).toThrow();
  });
  it('property: lower <= estimate <= upper within [0, 1]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, f) => {
        const k = Math.floor(f * n);
        const w = wilson(k, n);
        expect(w.lower!).toBeGreaterThanOrEqual(0);
        expect(w.upper!).toBeLessThanOrEqual(1);
        expect(w.lower!).toBeLessThanOrEqual(w.estimate! + 1e-12);
        expect(w.upper!).toBeGreaterThanOrEqual(w.estimate! - 1e-12);
      }),
    );
  });
});

describe('quantile7 and summarise', () => {
  it('matches R type 7', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile7(xs, 0.25)).toBeCloseTo(3.25);
    expect(quantile7(xs, 0.5)).toBe(5.5);
    expect(quantile7(xs, 0.75)).toBeCloseTo(7.75);
    expect(quantile7([4], 0.9)).toBe(4);
  });
  it('summarises observations without reordering the stored list', () => {
    const s = summarise([5, 1, 3]);
    expect(s).toEqual({ n: 3, observations: [5, 1, 3], median: 3, q1: 2, q3: 4, min: 1, max: 5 });
  });
  it('reports an empty summary as nulls', () => {
    expect(summarise([])).toEqual({ n: 0, observations: [], median: null, q1: null, q3: null, min: null, max: null });
  });
  it('property: min <= q1 <= median <= q3 <= max and permutation invariant', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 1, maxLength: 40 }), (xs) => {
        const s = summarise(xs);
        expect(s.min!).toBeLessThanOrEqual(s.q1!);
        expect(s.q1!).toBeLessThanOrEqual(s.median!);
        expect(s.median!).toBeLessThanOrEqual(s.q3!);
        expect(s.q3!).toBeLessThanOrEqual(s.max!);
        const r = summarise([...xs].reverse());
        expect([r.median, r.q1, r.q3, r.min, r.max]).toEqual([s.median, s.q1, s.q3, s.min, s.max]);
      }),
    );
  });
});

describe('fnv1a32 and the per-condition stream', () => {
  it('matches the reference FNV-1a vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
  it('gives each condition its own deterministic stream', () => {
    const a1 = conditionStream(20261114, 'solo.CF.off');
    const a2 = conditionStream(20261114, 'solo.CF.off');
    const b = conditionStream(20261114, 'solo.CF.on');
    const sa = [a1(), a1(), a1()];
    expect([a2(), a2(), a2()]).toEqual(sa);
    expect([b(), b(), b()]).not.toEqual(sa);
  });
});

describe('bootstrapCostPerAccepted', () => {
  const obs = (cost: number, accepted: boolean) => ({ cost, accepted });
  const opts = { seed: 20261114, resamples: 2000, confidence: 0.95 };

  it('is deterministic for a condition and independent of observation order', () => {
    const xs = [obs(1, true), obs(2, false), obs(3, true), obs(4, true), obs(5, false)];
    const a = bootstrapCostPerAccepted(xs, 'c', opts);
    const b = bootstrapCostPerAccepted([...xs].reverse(), 'c', opts);
    expect(a).toEqual(b);
    expect(a.undefinedFraction).toBeGreaterThan(0);
    expect(a.lower).not.toBeNull();
  });

  it('keeps zero-success resamples, reports them as undefined, and an upper bound in that mass as unbounded', () => {
    // One accepted run in ten: P(no accepted in a resample) = 0.9^10 ≈ 0.35, far above 2.5%.
    const xs = [obs(1, true), ...Array.from({ length: 9 }, () => obs(1, false))];
    const r = bootstrapCostPerAccepted(xs, 'c', opts);
    expect(r.undefinedFraction).toBeGreaterThan(0.3);
    expect(r.undefinedFraction).toBeLessThan(0.4);
    expect(r.upper).toBeNull();
    expect(r.upperUnbounded).toBe(true);
    expect(r.lower).not.toBeNull();
    expect(r.resamples).toBe(2000);
  });

  it('is entirely undefined with zero observed successes', () => {
    const r = bootstrapCostPerAccepted([obs(2, false), obs(3, false)], 'c', opts);
    expect(r.undefinedFraction).toBe(1);
    expect(r.lower).toBeNull();
    expect(r.upper).toBeNull();
    expect(r.lowerUnbounded).toBe(true);
    expect(r.upperUnbounded).toBe(true);
  });

  it('collapses to the point estimate when every observation is identical', () => {
    const r = bootstrapCostPerAccepted(Array.from({ length: 10 }, () => obs(2.5, true)), 'c', opts);
    expect(r.lower).toBeCloseTo(2.5, 12);
    expect(r.upper).toBeCloseTo(2.5, 12);
    expect(r.undefinedFraction).toBe(0);
  });

  it('rejects an empty condition and non-finite or negative costs', () => {
    expect(() => bootstrapCostPerAccepted([], 'c', opts)).toThrow();
    expect(() => bootstrapCostPerAccepted([obs(-1, true)], 'c', opts)).toThrow();
    expect(() => bootstrapCostPerAccepted([obs(Number.NaN, true)], 'c', opts)).toThrow();
  });

  it('property: finite bounds bracket nothing outside the observed per-accepted range', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ cost: fc.integer({ min: 0, max: 1000 }), accepted: fc.boolean() }), { minLength: 1, maxLength: 12 }), (xs) => {
        const r = bootstrapCostPerAccepted(xs, 'p', { ...opts, resamples: 300 });
        expect(r.undefinedFraction).toBeGreaterThanOrEqual(0);
        expect(r.undefinedFraction).toBeLessThanOrEqual(1);
        const maxTotal = xs.length * Math.max(...xs.map((x) => x.cost));
        if (r.lower !== null) expect(r.lower).toBeGreaterThanOrEqual(0);
        if (r.upper !== null) expect(r.upper).toBeLessThanOrEqual(maxTotal + 1e-9);
        if (r.lower !== null && r.upper !== null) expect(r.lower).toBeLessThanOrEqual(r.upper);
      }),
      { numRuns: 60 },
    );
  });
});
