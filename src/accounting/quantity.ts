/**
 * Token quantities as closed intervals. A measured count is exact (`lo === hi`). A count that depends
 * on an unsettled counter semantics is a bounded interval. A category the client does not report, or
 * the true total of an interrupted stage, has no upper bound (`hi === null`). A count is never
 * silently turned into zero: `{ lo: 0, hi: null }` is "unknown", `{ lo: 0, hi: 0 }` is "measured zero".
 */

/** The five billable cost.dev dimensions (config/analysis.json `billableDimensions`). */
export const BILLABLE = ['input_tokens', 'cached_input_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'output_tokens'] as const;
export type Billable = (typeof BILLABLE)[number];

/**
 * Normalised categories: the billable dimensions plus cache writes whose TTL the client did not
 * split. Those are priced between the 5-minute and 1-hour rates, never assigned to one silently.
 */
export const CATEGORIES = [...BILLABLE, 'cache_write_unsplit_tokens'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Quantity {
  lo: number;
  hi: number | null;
}

export type TokenVector = Record<Category, Quantity>;
export type ExactVector = Record<Category, number>;

export const exact = (n: number): Quantity => ({ lo: n, hi: n });
export const UNKNOWN: Quantity = Object.freeze({ lo: 0, hi: null }) as Quantity;
export const isExact = (q: Quantity): boolean => q.hi !== null && q.lo === q.hi;
export const isZero = (q: Quantity): boolean => q.lo === 0 && q.hi === 0;

export function add(a: Quantity, b: Quantity): Quantity {
  return { lo: a.lo + b.lo, hi: a.hi === null || b.hi === null ? null : a.hi + b.hi };
}

/** Bounds of `a - n` for an exact `n` already known to be part of `a`; never below zero. */
export function minus(a: Quantity, n: number): Quantity {
  return { lo: Math.max(0, a.lo - n), hi: a.hi === null ? null : Math.max(0, a.hi - n) };
}

export const vector = (f: (c: Category) => Quantity): TokenVector => Object.fromEntries(CATEGORIES.map((c) => [c, f(c)])) as TokenVector;
export const zeroVector = (): TokenVector => vector(() => exact(0));
export const unknownVector = (): TokenVector => vector(() => ({ ...UNKNOWN }));
export const zeroExact = (): ExactVector => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as ExactVector;

export const addVectors = (a: TokenVector, b: TokenVector): TokenVector => vector((c) => add(a[c], b[c]));
export const sumVectors = (vs: TokenVector[]): TokenVector => vs.reduce(addVectors, zeroVector());
export const fromExact = (v: ExactVector): TokenVector => vector((c) => exact(v[c]));

/** True when the interval gives a usable non-negative bound (`hi`, when present, is not below `lo`). */
export const wellFormed = (q: Quantity): boolean => Number.isFinite(q.lo) && q.lo >= 0 && (q.hi === null || (Number.isFinite(q.hi) && q.hi >= q.lo));
