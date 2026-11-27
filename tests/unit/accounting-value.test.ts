import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { UsageBucket } from '../../src/accounting/normalise.ts';
import { parsePriceSnapshot, picoPerToken, scaleSnapshot } from '../../src/accounting/prices.ts';
import { CATEGORIES, exact, zeroExact, type ExactVector, type TokenVector } from '../../src/accounting/quantity.ts';
import { addCosts, costFromJson, costJson, costStatus, priceRowFor, remainder, sumCosts, valueBucket, valueBuckets, type Cost } from '../../src/accounting/value.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const SNAP = parsePriceSnapshot(readFileSync(join(ROOT, 'prices', 'cost-dev-2026-11-13.csv'), 'utf8'));
const HAIKU = SNAP.get('anthropic:claude-haiku-5-5')!;
const OPUS = SNAP.get('anthropic:claude-opus-5-5')!;
const ASTRA = SNAP.get('openai:gpt-6-astra')!;

const ev = (o: Partial<ExactVector>): ExactVector => ({ ...zeroExact(), ...o });
const tv = (o: Partial<Record<keyof ExactVector, number | [number, number | null]>>): TokenVector =>
  Object.fromEntries(CATEGORIES.map((c) => {
    const v = o[c] ?? 0;
    return [c, Array.isArray(v) ? { lo: v[0], hi: v[1] } : exact(v)];
  })) as TokenVector;
const promptOf = (v: ExactVector) => v.input_tokens + v.cached_input_tokens + v.cache_write_5m_tokens + v.cache_write_1h_tokens + v.cache_write_unsplit_tokens;
const bucket = (tokens: TokenVector, requests: ExactVector[] = [], prompt?: { lo: number; hi: number | null }): UsageBucket => ({
  model: 'm',
  auxiliary: false,
  tokens,
  prompt: prompt ?? CATEGORIES.filter((c) => c !== 'output_tokens').reduce((a, c) => ({ lo: a.lo + tokens[c].lo, hi: a.hi === null || tokens[c].hi === null ? null : a.hi + tokens[c].hi! }), { lo: 0, hi: 0 as number | null }),
  requests: requests.map((t, i) => ({ id: `r${i}`, prompt: promptOf(t), tokens: t })),
});
const usd = (r: string, tokens: number) => picoPerToken(r) * BigInt(tokens);

describe('valueBucket', () => {
  it('prices exact usage on a flat book', () => {
    const c = valueBucket(bucket(tv({ input_tokens: 1000, cached_input_tokens: 2000, cache_write_5m_tokens: 300, cache_write_1h_tokens: 40, output_tokens: 500 })), OPUS, 'anthropic:claude-opus-5-5');
    const expected = usd('4', 1000) + usd('0.2', 2000) + usd('5', 300) + usd('8', 40) + usd('20', 500);
    expect(c).toEqual({ lo: expected, hi: expected, reasons: [] });
    expect(costJson(c)).toMatchObject({ status: 'exact', picoUsd: expected.toString() });
  });

  it('tiers each observed request by its own prompt length', () => {
    const small = ev({ input_tokens: 90_000, output_tokens: 100 });
    const large = ev({ input_tokens: 10, cached_input_tokens: 100_000, output_tokens: 100 });
    const total = tv({ input_tokens: 90_010, cached_input_tokens: 100_000, output_tokens: 200 });
    const c = valueBucket(bucket(total, [small, large]), HAIKU, 'h');
    const expected = usd('0.1', 90_000) + usd('0.5', 100) + usd('0.5', 10) + usd('0.05', 100_000) + usd('2.5', 100);
    expect(costStatus(c)).toBe('exact');
    expect(c.lo).toBe(expected);
  });

  it('prices provably small unattributed usage (auxiliary calls) at the base tier', () => {
    const r = ev({ input_tokens: 1000, output_tokens: 10 });
    const c = valueBucket(bucket(tv({ input_tokens: 1000, cached_input_tokens: 5000, output_tokens: 15 }), [r]), HAIKU, 'h');
    expect(costStatus(c)).toBe('exact');
    expect(c.lo).toBe(usd('0.1', 1000) + usd('0.5', 15) + usd('0.01', 5000));
  });

  it('bounds unattributed usage when a long-tier request could have produced it', () => {
    const r = ev({ input_tokens: 150_000, output_tokens: 10 });
    const c = valueBucket(bucket(tv({ input_tokens: 150_000, output_tokens: 20 }), [r]), HAIKU, 'h');
    expect(costStatus(c)).toBe('bounded');
    expect(c.lo).toBe(usd('0.5', 150_000) + usd('2.5', 10) + usd('0.5', 10));
    expect(c.hi).toBe(usd('0.5', 150_000) + usd('2.5', 10) + usd('2.5', 10));
    expect(c.reasons.join()).toMatch(/tier of unattributed usage undetermined/);
  });

  it('aggregate-only usage (Codex) is base-tier only when the whole stage prompt is within the threshold', () => {
    const under = valueBucket(bucket(tv({ input_tokens: 100_000, cached_input_tokens: 100_000, output_tokens: 10 })), ASTRA, 'a');
    expect(costStatus(under)).toBe('exact');
    const over = valueBucket(bucket(tv({ input_tokens: 200_000, cached_input_tokens: 100_000, output_tokens: 10 })), ASTRA, 'a');
    expect(costStatus(over)).toBe('bounded');
    expect(over.lo).toBe(usd('10', 200_000) + usd('1', 100_000) + usd('50', 10));
    expect(over.hi).toBe(usd('20', 200_000) + usd('2', 100_000) + usd('75', 10));
  });

  it('prices TTL-unsplit cache writes between the 5m and 1h rates', () => {
    const c = valueBucket(bucket(tv({ cache_write_unsplit_tokens: 1000 })), OPUS, 'o');
    expect([c.lo, c.hi]).toEqual([usd('5', 1000), usd('8', 1000)]);
  });

  it('pools cache writes whose TTL split differs between request and total counters (no double count)', () => {
    const r = ev({ input_tokens: 10, cache_write_5m_tokens: 200, output_tokens: 1 });
    const b = bucket(tv({ input_tokens: 10, cache_write_unsplit_tokens: 200, output_tokens: 1 }), [r]);
    const rem = remainder(b);
    expect(rem.tokens.cache_write_unsplit_tokens).toEqual({ lo: 0, hi: 0 });
    expect(valueBucket(b, OPUS, 'o')).toEqual({ lo: usd('4', 10) + usd('5', 200) + usd('20', 1), hi: usd('4', 10) + usd('5', 200) + usd('20', 1), reasons: [] });
  });

  it('unknown categories leave the cost without an upper bound; it is never priced as zero', () => {
    const c = valueBucket(bucket(tv({ input_tokens: 100, cache_write_5m_tokens: [0, null] })), ASTRA, 'a');
    expect(costStatus(c)).toBe('lower-bound');
    expect(c.lo).toBe(usd('10', 100));
    expect(costJson(c).usd).toBeNull();
  });

  it('a category the book does not price leaves the cost unbounded', () => {
    const c = valueBucket(bucket(tv({ input_tokens: 1, cache_write_1h_tokens: 5 })), ASTRA, 'a');
    expect(costStatus(c)).toBe('lower-bound');
    expect(c.reasons.join()).toMatch(/publishes no cache_write_1h_tokens rate/);
  });

  it('a missing price row makes the cost unavailable', () => {
    const c = valueBucket(bucket(tv({ input_tokens: 1 })), undefined, 'anthropic:claude-tiny');
    expect(costStatus(c)).toBe('unavailable');
    expect(costJson(c)).toMatchObject({ usd: null, lowerUsd: null, upperUsd: null });
  });

  it('measured zero usage costs exactly zero', () => {
    expect(valueBucket(bucket(tv({})), HAIKU, 'h')).toEqual({ lo: 0n, hi: 0n, reasons: [] });
  });
});

describe('cost arithmetic', () => {
  it('unknown propagates through sums', () => {
    const exactC: Cost = { lo: 5n, hi: 5n, reasons: [] };
    expect(costStatus(addCosts(exactC, { lo: null, hi: null, reasons: ['x'] }))).toBe('unavailable');
    expect(costStatus(addCosts(exactC, { lo: 1n, hi: null, reasons: [] }))).toBe('lower-bound');
    expect(sumCosts([])).toEqual({ lo: 0n, hi: 0n, reasons: [] });
  });

  it('JSON round-trips exactly', () => {
    for (const c of [{ lo: 123456789012345678n, hi: 123456789012345678n, reasons: [] }, { lo: 1n, hi: null, reasons: ['r'] }, { lo: null, hi: null, reasons: ['n'] }] as Cost[]) expect(costFromJson(costJson(c))).toEqual(c);
  });

  it('priceRowFor uses the role row for the requested model and provider:model otherwise', () => {
    expect(priceRowFor({ provider: 'anthropic', model: 'claude-opus-5-5', requestedModel: 'claude-opus-5-5', rolePriceRow: 'anthropic:claude-opus-5-5' })).toBe('anthropic:claude-opus-5-5');
    expect(priceRowFor({ provider: 'anthropic', model: 'claude-haiku-5-5', requestedModel: 'claude-opus-5-5', rolePriceRow: 'anthropic:claude-opus-5-5' })).toBe('anthropic:claude-haiku-5-5');
  });

  it('valueBuckets totals equal the sum of per-model costs', () => {
    const v = valueBuckets([{ ...bucket(tv({ input_tokens: 10 })), model: 'claude-opus-5-5' }, { ...bucket(tv({ output_tokens: 10 })), model: 'claude-haiku-5-5', auxiliary: true }], SNAP, (b) => `anthropic:${b.model}`);
    expect(v.cost.lo).toBe(usd('4', 10) + usd('0.5', 10));
  });
});

describe('valuation properties', () => {
  const n = fc.nat({ max: 400_000 });
  const exactVec = fc.record(Object.fromEntries(CATEGORIES.map((c) => [c, n])) as Record<keyof ExactVector, fc.Arbitrary<number>>);
  const books = [HAIKU, OPUS, ASTRA, SNAP.get('openai:gpt-6-luna')!];
  const interval = n.chain((lo) => fc.oneof(fc.constant(lo), fc.integer({ min: lo, max: lo + 400_000 }), fc.constant(null)).map((hi) => ({ lo, hi })));
  const vec = fc.record(Object.fromEntries(CATEGORIES.map((c) => [c, interval])) as Record<keyof ExactVector, fc.Arbitrary<{ lo: number; hi: number | null }>>);

  it('costs are non-negative and lower ≤ upper for arbitrary usage, requests and books', () => {
    fc.assert(
      fc.property(vec, fc.array(exactVec, { maxLength: 4 }), fc.constantFrom(...books), (tokens, reqs, book) => {
        const c = valueBucket(bucket(tokens as TokenVector, reqs), book, book.modelId);
        expect(c.lo! >= 0n).toBe(true);
        if (c.hi !== null) expect(c.hi >= c.lo!).toBe(true);
      }),
    );
  });

  it('exact usage fully attributed to requests is priced exactly', () => {
    fc.assert(
      fc.property(fc.array(exactVec, { minLength: 1, maxLength: 4 }), fc.constantFrom(...books), (reqs, book) => {
        const total = Object.fromEntries(CATEGORIES.map((c) => [c, exact(reqs.reduce((a, r) => a + r[c], 0))])) as TokenVector;
        const b = bucket(total, reqs);
        // TTL-unsplit writes are bounded by design; OpenAI books publish no 1h rate (then unbounded).
        const split = reqs.every((r) => r.cache_write_unsplit_tokens === 0);
        const priceable = book.base.cache_write_1h_tokens !== undefined || reqs.every((r) => r.cache_write_1h_tokens === 0);
        const status = costStatus(valueBucket(b, book, book.modelId));
        if (split && priceable) expect(status).toBe('exact');
        else expect(status).not.toBe('exact');
      }),
    );
  });

  it('repricing is linear within fixed tiers and never changes measured quantities', () => {
    fc.assert(
      fc.property(vec, fc.array(exactVec, { maxLength: 3 }), fc.constantFrom(...books), fc.bigInt({ min: 1n, max: 50n }), (tokens, reqs, book, k) => {
        const b = bucket(tokens as TokenVector, reqs);
        const before = JSON.stringify(b);
        const c1 = valueBucket(b, book, 'x');
        const c2 = valueBucket(b, scaleSnapshot(new Map([[book.modelId, book]]), k).get(book.modelId), 'x');
        expect(c2.lo).toBe(c1.lo === null ? null : c1.lo * k);
        expect(c2.hi).toBe(c1.hi === null ? null : c1.hi * k);
        expect(JSON.stringify(b)).toBe(before);
      }),
    );
  });

  it('sums are order-independent (permutation invariance)', () => {
    const cost = fc.record({ lo: fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n })), hi: fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n })), reasons: fc.constant([] as string[]) });
    fc.assert(
      fc.property(fc.array(cost, { maxLength: 8 }), fc.integer(), (cs, seed) => {
        const shuffled = [...cs].sort(() => ((seed = (seed * 1103515245 + 12345) | 0) & 1 ? 1 : -1));
        const a = sumCosts(cs);
        const b = sumCosts(shuffled);
        expect([a.lo, a.hi]).toEqual([b.lo, b.hi]);
      }),
    );
  });
});
