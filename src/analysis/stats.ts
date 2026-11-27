/**
 * Uncertainty methods frozen in methodology section 11 and config/analysis.json. Pure functions.
 *
 * - Acceptance: Wilson score interval.
 * - Elapsed time and token totals: every observation, median, IQR (type-7 quantiles), range.
 * - Cost per accepted workflow: within-condition percentile bootstrap of Σ cost ÷ Σ accepted, with
 *   mulberry32 seeded by `seed XOR fnv1a32(conditionId)`. Zero-accepted resamples are kept and
 *   ordered as +∞; a bound that lands in (or interpolates into) that mass is reported as unbounded.
 */
import { mulberry32 } from '../orchestrator/schedule.ts';

export interface Proportion {
  estimate: number | null;
  lower: number | null;
  upper: number | null;
}

/** Two-sided normal quantile for the confidence levels we use (only 0.95 is frozen). */
function zFor(confidence: number): number {
  if (confidence === 0.95) return 1.959963984540054;
  throw new Error(`unsupported confidence ${confidence}`);
}

export function wilson(k: number, n: number, confidence = 0.95): Proportion {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new Error(`invalid proportion ${k}/${n}`);
  if (n === 0) return { estimate: null, lower: null, upper: null };
  const z = zFor(confidence);
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { estimate: p, lower: k === 0 ? 0 : Math.max(0, centre - half), upper: k === n ? 1 : Math.min(1, centre + half) };
}

/** Type-7 (R default) quantile of an ascending-sorted array. */
function q7sorted(sorted: readonly number[], p: number): number {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

export function quantile7(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new Error('quantile of no observations');
  return q7sorted([...xs].sort((a, b) => a - b), p);
}

export interface Summary {
  n: number;
  /** Every observation, in the order supplied (callers pass schedule order). */
  observations: number[];
  median: number | null;
  q1: number | null;
  q3: number | null;
  min: number | null;
  max: number | null;
}

export function summarise(xs: readonly number[]): Summary {
  if (xs.length === 0) return { n: 0, observations: [], median: null, q1: null, q3: null, min: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  return { n: xs.length, observations: [...xs], median: q7sorted(s, 0.5), q1: q7sorted(s, 0.25), q3: q7sorted(s, 0.75), min: s[0]!, max: s[s.length - 1]! };
}

/** 32-bit FNV-1a over the UTF-8 bytes of `s`. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const conditionStream = (seed: number, conditionId: string): (() => number) => mulberry32((seed ^ fnv1a32(conditionId)) >>> 0);

export interface BootstrapOptions {
  seed: number;
  resamples: number;
  confidence: number;
}

export interface BootstrapResult {
  method: 'percentile';
  resamples: number;
  confidence: number;
  /** Fraction of resamples with zero accepted workflows (no finite statistic). */
  undefinedFraction: number;
  /** Finite bound in the cost unit supplied, or null when the bound is unbounded/undefined. */
  lower: number | null;
  upper: number | null;
  lowerUnbounded: boolean;
  upperUnbounded: boolean;
}

/**
 * Resample `obs` with replacement `resamples` times. Observations are put into a canonical order
 * first (by cost then acceptance) so the result does not depend on the order they were read in.
 */
export function bootstrapCostPerAccepted(obs: ReadonlyArray<{ cost: number; accepted: boolean }>, conditionId: string, o: BootstrapOptions): BootstrapResult {
  if (obs.length === 0) throw new Error(`${conditionId}: bootstrap of an empty condition`);
  for (const x of obs) if (!Number.isFinite(x.cost) || x.cost < 0) throw new Error(`${conditionId}: invalid cost ${x.cost}`);
  const xs = [...obs].sort((a, b) => a.cost - b.cost || Number(a.accepted) - Number(b.accepted));
  const rand = conditionStream(o.seed, conditionId);
  const n = xs.length;
  const stats = new Float64Array(o.resamples);
  let undef = 0;
  for (let r = 0; r < o.resamples; r++) {
    let total = 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[Math.floor(rand() * n)]!;
      total += x.cost;
      if (x.accepted) acc++;
    }
    if (acc === 0) {
      stats[r] = Number.POSITIVE_INFINITY;
      undef++;
    } else stats[r] = total / acc;
  }
  const sorted = Array.from(stats).sort((a, b) => a - b);
  const alpha = (1 - o.confidence) / 2;
  const bound = (p: number): number | null => {
    const h = (sorted.length - 1) * p;
    const v = sorted[Math.ceil(h)]!;
    return Number.isFinite(v) ? q7sorted(sorted, p) : null;
  };
  const lower = bound(alpha);
  const upper = bound(1 - alpha);
  return { method: 'percentile', resamples: o.resamples, confidence: o.confidence, undefinedFraction: undef / o.resamples, lower, upper, lowerUnbounded: lower === null, upperUnbounded: upper === null };
}
