import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePriceSnapshot, picoPerToken, picoToUsd, scaleSnapshot, splitCsvLine } from '../../src/accounting/prices.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const CSV = readFileSync(join(ROOT, 'prices', 'cost-dev-2026-11-13.csv'), 'utf8');
const HEADER = 'model_id,display_name,price_book_id,channel,service_mode,region,currency,effective_from,verified_at,cost_dev_source_id,dimension,unit,unit_size,tier_basis,tier_condition,price,raw_file';
const row = (o: Partial<Record<string, string>>) =>
  [o.model ?? 'x:m', 'M', o.book ?? 'pb', 'direct', 'realtime', 'global', o.currency ?? 'USD', '', '', '', o.dim ?? 'input_tokens', o.unit ?? 'tokens', o.size ?? '1000000', o.basis ?? '', o.cond ?? '', o.price ?? '1', 'raw.json'].join(',');

describe('picoPerToken', () => {
  it('converts USD per 1M tokens exactly', () => {
    expect(picoPerToken('4')).toBe(4_000_000n);
    expect(picoPerToken('0.125')).toBe(125_000n);
    expect(picoPerToken('0.01')).toBe(10_000n);
    expect(picoPerToken('75')).toBe(75_000_000n);
  });

  it('rejects anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', '-1', '1e3', '0.1234567', 'abc', '1.']) expect(() => picoPerToken(bad)).toThrow();
  });

  it('round-trips any six-decimal rate (property)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 999_999 }), (whole, frac) => {
        const s = `${whole}.${String(frac).padStart(6, '0')}`;
        expect(picoPerToken(s)).toBe(BigInt(whole) * 1_000_000n + BigInt(frac));
        expect(picoToUsd(picoPerToken(s) * 1_000_000n)).toBeCloseTo(Number(s), 6);
      }),
    );
  });
});

describe('splitCsvLine', () => {
  it('handles quoted commas and doubled quotes', () => {
    expect(splitCsvLine('a,"b,c","d""e",')).toEqual(['a', 'b,c', 'd"e', '']);
  });
});

describe('parsePriceSnapshot (committed snapshot)', () => {
  const s = parsePriceSnapshot(CSV);

  it('has the four selected books with the documented thresholds', () => {
    expect([...s.keys()].sort()).toEqual(['anthropic:claude-haiku-5-5', 'anthropic:claude-opus-5-5', 'openai:gpt-6-astra', 'openai:gpt-6-luna']);
    expect(s.get('openai:gpt-6-astra')!.threshold).toBe(272_000);
    expect(s.get('openai:gpt-6-luna')!.threshold).toBe(272_000);
    expect(s.get('anthropic:claude-haiku-5-5')!.threshold).toBe(100_000);
    expect(s.get('anthropic:claude-opus-5-5')!.threshold).toBeNull();
  });

  it('matches the rates in prices/README.md', () => {
    const astra = s.get('openai:gpt-6-astra')!;
    expect(astra.base).toEqual({ input_tokens: picoPerToken('10'), cached_input_tokens: picoPerToken('1'), cache_write_5m_tokens: picoPerToken('12.5'), output_tokens: picoPerToken('50') });
    expect(astra.long.output_tokens).toBe(picoPerToken('75'));
    expect(astra.base.cache_write_1h_tokens).toBeUndefined();
    const opus = s.get('anthropic:claude-opus-5-5')!;
    expect(opus.base).toEqual({ input_tokens: picoPerToken('4'), cached_input_tokens: picoPerToken('0.2'), cache_write_5m_tokens: picoPerToken('5'), cache_write_1h_tokens: picoPerToken('8'), output_tokens: picoPerToken('20') });
    expect(opus.long).toEqual({});
    const haiku = s.get('anthropic:claude-haiku-5-5')!;
    for (const [d, v] of Object.entries(haiku.base)) expect(haiku.long[d as keyof typeof haiku.long]).toBe(v! * 5n);
  });

  it('every long-tier rate is at least the base rate', () => {
    for (const b of s.values()) for (const [d, v] of Object.entries(b.long)) expect(v! >= b.base[d as keyof typeof b.base]!).toBe(true);
  });
});

describe('parsePriceSnapshot (validation)', () => {
  it('rejects unknown dimensions, units and tier forms', () => {
    expect(() => parsePriceSnapshot(`${HEADER}\n${row({ dim: 'reasoning_tokens' })}`)).toThrow(/unknown dimension/);
    expect(() => parsePriceSnapshot(`${HEADER}\n${row({ size: '1000' })}`)).toThrow(/1,000,000/);
    expect(() => parsePriceSnapshot(`${HEADER}\n${row({ basis: 'input_tokens', cond: '>= 5' })}`)).toThrow(/unsupported tier/);
  });

  it('rejects duplicates, mixed books, inconsistent thresholds and lopsided tiers', () => {
    expect(() => parsePriceSnapshot(`${HEADER}\n${row({})}\n${row({})}`)).toThrow(/duplicate/);
    expect(() => parsePriceSnapshot(`${HEADER}\n${row({})}\n${row({ dim: 'output_tokens', book: 'other' })}`)).toThrow(/mixes/);
    expect(() => parsePriceSnapshot(`${HEADER}\n${row({ basis: 'input_tokens', cond: '<= 10' })}\n${row({ basis: 'input_tokens', cond: '> 20' })}`)).toThrow(/threshold/);
    expect(() => parsePriceSnapshot(`${HEADER}\n${row({ basis: 'input_tokens', cond: '<= 10' })}\n${row({ dim: 'output_tokens', basis: 'input_tokens', cond: '<= 10' })}\n${row({ basis: 'input_tokens', cond: '> 10' })}`)).toThrow(/same dimensions/);
  });

  it('rejects a missing column and an empty file', () => {
    expect(() => parsePriceSnapshot('')).toThrow(/empty/);
    expect(() => parsePriceSnapshot('model_id,price\nx,1')).toThrow(/lacks column/);
  });

  it('scaleSnapshot multiplies every rate', () => {
    const s = parsePriceSnapshot(CSV);
    const t = scaleSnapshot(s, 3n);
    expect(t.get('openai:gpt-6-luna')!.long.input_tokens).toBe(s.get('openai:gpt-6-luna')!.long.input_tokens! * 3n);
    expect(t.get('openai:gpt-6-luna')!.threshold).toBe(272_000);
  });
});
