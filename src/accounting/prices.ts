/**
 * The dated cost.dev price snapshot (prices/cost-dev-2026-11-13.csv, methodology section 10).
 *
 * Rates are held as exact integers in pico-USD per token (USD per 1,000,000 tokens × 10^6), so
 * every cost is an exact BigInt sum: repricing is linear, workflow totals equal their stage totals
 * to the last unit, and no floating-point rounding enters a comparison.
 */
import { BILLABLE, type Billable } from './quantity.ts';

export interface PriceBook {
  modelId: string;
  priceBookId: string;
  currency: string;
  /** Prompt-length threshold for the long-context tier, or null for a flat book. */
  threshold: number | null;
  base: Partial<Record<Billable, bigint>>;
  /** Rates when one request's prompt exceeds `threshold`. Empty for a flat book. */
  long: Partial<Record<Billable, bigint>>;
}

export type PriceSnapshot = Map<string, PriceBook>;

/** Exact decimal string → pico-USD per token, from a USD-per-1M rate. At most six decimals. */
export function picoPerToken(rate: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(rate.trim());
  if (!m) throw new Error(`invalid rate ${JSON.stringify(rate)}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
}

/** Pico-USD → USD as a number, for display only. Comparisons and sums use the BigInt. */
export const picoToUsd = (p: bigint): number => Number(p) / 1e12;

/** Minimal RFC 4180 line splitter (quoted fields, doubled quotes). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const REQUIRED = ['model_id', 'price_book_id', 'currency', 'dimension', 'unit', 'unit_size', 'tier_basis', 'tier_condition', 'price'] as const;

/** Pure: parse and validate the flattened snapshot. Throws on anything ambiguous rather than guessing. */
export function parsePriceSnapshot(csv: string): PriceSnapshot {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('empty price snapshot');
  const header = splitCsvLine(lines[0]!);
  const col = Object.fromEntries(REQUIRED.map((k) => [k, header.indexOf(k)])) as Record<(typeof REQUIRED)[number], number>;
  for (const k of REQUIRED) if (col[k] < 0) throw new Error(`price snapshot lacks column ${k}`);
  const books: PriceSnapshot = new Map();
  for (const [n, line] of lines.slice(1).entries()) {
    const f = splitCsvLine(line);
    const get = (k: (typeof REQUIRED)[number]) => (f[col[k]] ?? '').trim();
    const where = `row ${n + 2}`;
    const dim = get('dimension');
    if (!(BILLABLE as readonly string[]).includes(dim)) throw new Error(`${where}: unknown dimension ${dim}`);
    if (get('unit') !== 'tokens' || get('unit_size') !== '1000000') throw new Error(`${where}: expected USD per 1,000,000 tokens`);
    const modelId = get('model_id');
    const book = books.get(modelId) ?? { modelId, priceBookId: get('price_book_id'), currency: get('currency'), threshold: null, base: {}, long: {} };
    if (book.priceBookId !== get('price_book_id') || book.currency !== get('currency')) throw new Error(`${where}: ${modelId} mixes price books or currencies`);
    const cond = get('tier_condition');
    const rate = picoPerToken(get('price'));
    let side: 'base' | 'long' = 'base';
    if (cond !== '') {
      const c = /^(<=|>)\s*(\d+)$/.exec(cond);
      if (!c || get('tier_basis') !== 'input_tokens') throw new Error(`${where}: unsupported tier ${get('tier_basis')} ${cond}`);
      const t = Number(c[2]);
      if (book.threshold !== null && book.threshold !== t) throw new Error(`${where}: ${modelId} has more than one tier threshold`);
      book.threshold = t;
      side = c[1] === '>' ? 'long' : 'base';
    }
    if (book[side][dim as Billable] !== undefined) throw new Error(`${where}: duplicate ${modelId} ${dim} ${side}`);
    book[side][dim as Billable] = rate;
    books.set(modelId, book);
  }
  for (const b of books.values()) {
    const baseDims = Object.keys(b.base).sort().join();
    if (b.threshold !== null && baseDims !== Object.keys(b.long).sort().join()) throw new Error(`${b.modelId}: tiered rows do not cover the same dimensions`);
    if (b.threshold === null && Object.keys(b.long).length) throw new Error(`${b.modelId}: long-tier rows without a threshold`);
  }
  return books;
}

/** Multiply every rate by an integer factor (used by the repricing-linearity property). */
export function scaleSnapshot(s: PriceSnapshot, k: bigint): PriceSnapshot {
  const scale = (r: Partial<Record<Billable, bigint>>) => Object.fromEntries(Object.entries(r).map(([d, v]) => [d, v! * k])) as Partial<Record<Billable, bigint>>;
  return new Map([...s].map(([id, b]) => [id, { ...b, base: scale(b.base), long: scale(b.long) }]));
}
