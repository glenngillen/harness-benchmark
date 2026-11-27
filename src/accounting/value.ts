/**
 * Model-specific valuation of normalised usage (methodology section 10). Pure and exact: every
 * amount is a BigInt in pico-USD, so totals are associative and repricing is linear.
 *
 * Each observed request is tiered by its own prompt length. Usage that cannot be attributed to an
 * observed request is tiered only when that is provable: the book is flat, or every observed request
 * of the model is in the base tier and the unattributed prompt total is itself within the threshold
 * (no single unattributed request can then exceed it). Otherwise it is bounded below at base rates
 * and above at long-context rates. A missing price row leaves the cost unavailable; an unknown
 * category or rate leaves it without an upper bound. Nothing is priced as zero by default.
 */
import type { UsageBucket } from './normalise.ts';
import type { PriceBook, PriceSnapshot } from './prices.ts';
import { picoToUsd } from './prices.ts';
import { CATEGORIES, minus, zeroExact, type Billable, type Category, type Quantity, type TokenVector } from './quantity.ts';

export interface Cost {
  /** Lower bound in pico-USD; null when not even a lower bound is supported (no price row). */
  lo: bigint | null;
  /** Upper bound in pico-USD; null when unbounded (an unknown category, rate or interrupted stage). */
  hi: bigint | null;
  reasons: string[];
}

export type CostStatus = 'exact' | 'bounded' | 'lower-bound' | 'unavailable';

export const ZERO_COST: Cost = Object.freeze({ lo: 0n, hi: 0n, reasons: [] }) as unknown as Cost;

export function costStatus(c: Cost): CostStatus {
  if (c.lo === null) return 'unavailable';
  if (c.hi === null) return 'lower-bound';
  return c.lo === c.hi ? 'exact' : 'bounded';
}

export function addCosts(a: Cost, b: Cost): Cost {
  return { lo: a.lo === null || b.lo === null ? null : a.lo + b.lo, hi: a.hi === null || b.hi === null ? null : a.hi + b.hi, reasons: [...new Set([...a.reasons, ...b.reasons])] };
}
export const sumCosts = (cs: Cost[]): Cost => cs.reduce(addCosts, { ...ZERO_COST, reasons: [] });

type Tier = 'base' | 'long';

/** The rate bounds for one category at one tier; `undefined` where the book publishes no rate. */
function rateBounds(book: PriceBook, tier: Tier, c: Category): { lo: bigint | undefined; hi: bigint | undefined } {
  const at = (d: Billable): bigint | undefined => (tier === 'long' && book.threshold !== null ? book.long[d] : book.base[d]);
  if (c !== 'cache_write_unsplit_tokens') {
    const r = at(c);
    return { lo: r, hi: r };
  }
  const a = at('cache_write_5m_tokens');
  const b = at('cache_write_1h_tokens');
  if (a === undefined || b === undefined) return { lo: undefined, hi: undefined };
  return { lo: a < b ? a : b, hi: a < b ? b : a };
}

/** Price token bounds with lower-bound rates at `loTier` and upper-bound rates at `hiTier`. */
function priceVector(book: PriceBook, tokens: Record<Category, Quantity>, loTier: Tier, hiTier: Tier, label: string): Cost {
  let lo: bigint = 0n;
  let hi: bigint | null = 0n;
  const reasons: string[] = [];
  for (const c of CATEGORIES) {
    const t = tokens[c];
    if (t.lo === 0 && t.hi === 0) continue;
    const rl = rateBounds(book, loTier, c).lo;
    const rhCandidates = [rateBounds(book, hiTier, c).hi, rateBounds(book, loTier, c).hi];
    const rh = rhCandidates.includes(undefined) ? undefined : rhCandidates.reduce((m, r) => (r! > m! ? r : m));
    if (rl === undefined || rh === undefined) reasons.push(`${book.modelId} publishes no ${c === 'cache_write_unsplit_tokens' ? '5m/1h cache-write pair' : c} rate (${label})`);
    if (rl !== undefined) lo += BigInt(t.lo) * rl;
    if (hi !== null) hi = t.hi === null || rh === undefined ? null : hi + BigInt(t.hi) * rh;
    if (t.hi === null) reasons.push(`${c} unbounded (${label})`);
  }
  return { lo, hi, reasons };
}

const CW: Category[] = ['cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_unsplit_tokens'];

/** Pure: the bucket's usage not attributed to an observed request, with its prompt bounds. */
export function remainder(b: UsageBucket): { tokens: TokenVector; prompt: Quantity } {
  const reqSum = zeroExact();
  let reqPrompt = 0;
  for (const r of b.requests) {
    for (const c of CATEGORIES) reqSum[c] += r.tokens[c];
    reqPrompt += r.prompt;
  }
  const tokens = Object.fromEntries(CATEGORIES.map((c) => [c, minus(b.tokens[c], reqSum[c])])) as TokenVector;
  if (CW.some((c) => reqSum[c] > b.tokens[c].lo)) {
    // TTL split differs between request and total counters: pool cache writes as unsplit.
    const pooled = CW.reduce((a, c) => ({ lo: a.lo + b.tokens[c].lo, hi: a.hi === null || b.tokens[c].hi === null ? null : a.hi + b.tokens[c].hi! }), { lo: 0, hi: 0 } as Quantity);
    tokens.cache_write_5m_tokens = { lo: 0, hi: 0 };
    tokens.cache_write_1h_tokens = { lo: 0, hi: 0 };
    tokens.cache_write_unsplit_tokens = minus(pooled, CW.reduce((a, c) => a + reqSum[c], 0));
  }
  return { tokens, prompt: minus(b.prompt, reqPrompt) };
}

/** Pure: value one model bucket against its price book (or `undefined` when the snapshot has no row). */
export function valueBucket(b: UsageBucket, book: PriceBook | undefined, priceRow: string): Cost {
  if (!book) return { lo: null, hi: null, reasons: [`no price row ${priceRow} in the snapshot for ${b.model}`] };
  const parts: Cost[] = [];
  const longRequest = (p: number) => book.threshold !== null && p > book.threshold;
  for (const r of b.requests) {
    const tier: Tier = longRequest(r.prompt) ? 'long' : 'base';
    const tokens = Object.fromEntries(CATEGORIES.map((c) => [c, { lo: r.tokens[c], hi: r.tokens[c] }])) as TokenVector;
    parts.push(priceVector(book, tokens, tier, tier, `request ${r.id}`));
  }
  const rem = remainder(b);
  const empty = CATEGORIES.every((c) => rem.tokens[c].lo === 0 && rem.tokens[c].hi === 0);
  if (!empty) {
    let hiTier: Tier = 'base';
    if (book.threshold !== null) {
      const provable = !b.requests.some((r) => longRequest(r.prompt)) && rem.prompt.hi !== null && rem.prompt.hi <= book.threshold;
      if (!provable) {
        hiTier = 'long';
        parts.push({ lo: 0n, hi: 0n, reasons: [`${b.model}: prompt-length tier of unattributed usage undetermined; bounded by base and long-context rates`] });
      }
    }
    parts.push(priceVector(book, rem.tokens, 'base', hiTier, b.requests.length ? 'unattributed usage' : 'stage aggregate'));
  }
  return sumCosts(parts);
}

/** The price row for a serving model: the role's configured row for its requested model, else `provider:model`. */
export function priceRowFor(o: { provider: string; model: string; requestedModel: string | null; rolePriceRow: string | null }): string {
  return o.model === o.requestedModel && o.rolePriceRow ? o.rolePriceRow : `${o.provider}:${o.model}`;
}

export function valueBuckets(buckets: UsageBucket[], snapshot: PriceSnapshot, row: (b: UsageBucket) => string): { cost: Cost; byModel: Array<{ model: string; priceRow: string; cost: Cost }> } {
  const byModel = buckets.map((b) => {
    const priceRow = row(b);
    return { model: b.model, priceRow, cost: valueBucket(b, snapshot.get(priceRow), priceRow) };
  });
  return { cost: sumCosts(byModel.map((m) => m.cost)), byModel };
}

/** JSON form. Exact amounts keep the BigInt as a string; `usd` is set only for an exact cost. */
export interface CostJson {
  status: CostStatus;
  usd: number | null;
  picoUsd: string | null;
  lowerUsd: number | null;
  upperUsd: number | null;
  lowerPicoUsd: string | null;
  upperPicoUsd: string | null;
  reasons: string[];
}

export function costJson(c: Cost): CostJson {
  const status = costStatus(c);
  return {
    status,
    usd: status === 'exact' ? picoToUsd(c.lo!) : null,
    picoUsd: status === 'exact' ? c.lo!.toString() : null,
    lowerUsd: c.lo === null ? null : picoToUsd(c.lo),
    upperUsd: c.hi === null ? null : picoToUsd(c.hi),
    lowerPicoUsd: c.lo === null ? null : c.lo.toString(),
    upperPicoUsd: c.hi === null ? null : c.hi.toString(),
    reasons: c.reasons,
  };
}

/** Inverse of costJson (used when aggregating saved records). */
export function costFromJson(j: Pick<CostJson, 'lowerPicoUsd' | 'upperPicoUsd' | 'reasons'>): Cost {
  return { lo: j.lowerPicoUsd === null ? null : BigInt(j.lowerPicoUsd), hi: j.upperPicoUsd === null ? null : BigInt(j.upperPicoUsd), reasons: [...j.reasons] };
}
