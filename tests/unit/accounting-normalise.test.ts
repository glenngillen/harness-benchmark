import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normaliseStage, parseUsageSemantics, type CodexSemantics, type UsageSemantics } from '../../src/accounting/normalise.ts';
import { CATEGORIES, wellFormed } from '../../src/accounting/quantity.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const COMMITTED = parseUsageSemantics(JSON.parse(readFileSync(join(ROOT, 'config', 'usage-semantics.json'), 'utf8')));
const withCodex = (c: Partial<CodexSemantics>): UsageSemantics => ({ ...COMMITTED, codex: { ...COMMITTED.codex, ...c } });
/** Codex semantics as they stood before the pilots settled them, kept to test the unsettled-bounds path. */
const UNSETTLED = withCodex({ status: 'unverified', turnCompletedScope: null, cachedInputSubsetOfInput: null, reasoningIncludedInOutput: null, cacheWrites: 'not-reported' });
const SETTLED = withCodex({ status: 'verified', turnCompletedScope: 'per-turn', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true, cacheWrites: 'verified-not-billed' });

const HAIKU = 'claude-haiku-5-5';
// Field names as emitted by the installed Claude Code 2.1.323 (see tests/unit/claude-adapter.test.ts).
const mu = (input: number, out: number, cr = 0, cw = 0, split: [number, number] | null = [cw, 0]) => ({
  inputTokens: input,
  outputTokens: out,
  cacheReadInputTokens: cr,
  cacheCreationInputTokens: cw,
  ...(split ? { cacheCreationEphemeral5mInputTokens: split[0], cacheCreationEphemeral1hInputTokens: split[1] } : {}),
  webSearchRequests: 0,
  costUSD: 0.01,
});
const ru = (input: number, cr: number, cw: number, out: number) => ({ input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: out, cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 } });
const req = (id: string, u: object, model = HAIKU) => ({ kind: 'request', messageId: id, model, usage: u });
const res = (since: Record<string, unknown> | null, modelUsage: Record<string, unknown> | null = since) => ({ kind: 'result', index: 0, usage: null, sinceLastResult: since, modelUsage, nativeCostEstimateUsd: 0.5 });
const claudeStage = (raw: unknown[], o: { completeness?: string; before?: unknown; after?: unknown; requestedModel?: string } = {}) => ({
  tool: 'claude-code',
  provider: 'anthropic',
  requestedModel: o.requestedModel ?? HAIKU,
  mode: 'fresh',
  usage: { completeness: o.completeness ?? 'complete', raw, supplementary: { cumulativeBefore: o.before ?? null, cumulativeAfter: o.after ?? null } },
});

const cu = (input: number, cached: number, output: number, reasoning: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning });
const codexStage = (raw: unknown[], o: { mode?: string; completeness?: string; before?: unknown; after?: unknown } = {}) => ({
  tool: 'codex',
  provider: 'openai',
  requestedModel: 'gpt-6-luna',
  resolvedModel: 'gpt-6-luna',
  mode: o.mode ?? 'fresh',
  usage: { completeness: o.completeness ?? 'complete', raw, supplementary: { rolloutCumulativeBefore: o.before ?? null, rolloutCumulativeAfter: o.after ?? null } },
});

describe('parseUsageSemantics', () => {
  it('accepts the committed config with Codex semantics settled by the pilots', () => {
    expect(COMMITTED.codex).toMatchObject({ status: 'pilot-verified', turnCompletedScope: 'session-cumulative', cachedInputSubsetOfInput: true, reasoningIncludedInOutput: true, cacheWrites: 'not-reported' });
    expect(COMMITTED['claude-code'].cacheReadSeparateFromInput).toBe(true);
  });

  it('rejects typos instead of silently changing the accounting', () => {
    const base = JSON.parse(readFileSync(join(ROOT, 'config', 'usage-semantics.json'), 'utf8'));
    expect(() => parseUsageSemantics({ ...base, codex: { ...base.codex, turnCompletedScope: 'cumulative' } })).toThrow();
    expect(() => parseUsageSemantics({ ...base, codex: { ...base.codex, cachedInputSubsetOfInput: 'yes' } })).toThrow();
    expect(() => parseUsageSemantics({ ...base, codex: { ...base.codex, cacheWrites: 'zero' } })).toThrow();
    expect(() => parseUsageSemantics({ codex: base.codex })).toThrow();
  });
});

describe('Claude Code normalisation', () => {
  it('sums incremental counters and keeps per-request prompt lengths', () => {
    const n = normaliseStage(claudeStage([req('m1', ru(10, 0, 200, 20)), req('m2', ru(20, 1000, 0, 60)), res({ [HAIKU]: mu(30, 80, 1000, 200) })]), COMMITTED);
    expect(n.completeness).toBe('complete');
    expect(n.buckets).toHaveLength(1);
    const b = n.buckets[0]!;
    expect(b.auxiliary).toBe(false);
    expect(b.tokens).toEqual({
      input_tokens: { lo: 30, hi: 30 },
      cached_input_tokens: { lo: 1000, hi: 1000 },
      cache_write_5m_tokens: { lo: 200, hi: 200 },
      cache_write_1h_tokens: { lo: 0, hi: 0 },
      output_tokens: { lo: 80, hi: 80 },
      cache_write_unsplit_tokens: { lo: 0, hi: 0 },
    });
    expect(b.prompt).toEqual({ lo: 1230, hi: 1230 });
    expect(b.requests.map((r) => [r.id, r.prompt])).toEqual([
      ['m1', 210],
      ['m2', 1020],
    ]);
  });

  it('a resumed stage counts only its own incremental results, cross-checked against cumulative totals', () => {
    const before = { [HAIKU]: mu(30, 80, 1000, 200) };
    const after = { [HAIKU]: mu(35, 120, 2200, 200) };
    const n = normaliseStage(claudeStage([res({ [HAIKU]: mu(2, 10, 600, 0) }, null), res({ [HAIKU]: mu(3, 30, 600, 0) }, after)], { before, after }), COMMITTED);
    expect(n.buckets[0]!.tokens.input_tokens).toEqual({ lo: 5, hi: 5 });
    expect(n.buckets[0]!.tokens.cached_input_tokens).toEqual({ lo: 1200, hi: 1200 });
    expect(n.buckets[0]!.tokens.output_tokens).toEqual({ lo: 40, hi: 40 });
    expect(n.crossCheck.status).toBe('agrees');
    expect(n.derivation).toMatch(/sum of 2 result/);
  });

  it('flags a cumulative/incremental disagreement without changing the totals', () => {
    const n = normaliseStage(claudeStage([res({ [HAIKU]: mu(5, 40, 1200, 0) }, null)], { before: { [HAIKU]: mu(30, 80, 1000, 200) }, after: { [HAIKU]: mu(99, 120, 2200, 200) } }), COMMITTED);
    expect(n.crossCheck.status).toBe('differs');
    expect(n.buckets[0]!.tokens.input_tokens).toEqual({ lo: 5, hi: 5 });
  });

  it('reports auxiliary models as separate buckets', () => {
    const n = normaliseStage(claudeStage([res({ 'claude-opus-5-5': mu(10, 5), [HAIKU]: mu(1, 1) })], { requestedModel: 'claude-opus-5-5' }), COMMITTED);
    expect(n.buckets.map((b) => [b.model, b.auxiliary])).toEqual([
      ['claude-haiku-5-5', true],
      ['claude-opus-5-5', false],
    ]);
  });

  it('keeps cache writes without a TTL split as unsplit, never assigning them to one rate', () => {
    const n = normaliseStage(claudeStage([res({ [HAIKU]: mu(1, 1, 0, 500, null) })]), COMMITTED);
    const t = n.buckets[0]!.tokens;
    expect([t.cache_write_5m_tokens, t.cache_write_1h_tokens, t.cache_write_unsplit_tokens]).toEqual([
      { lo: 0, hi: 0 },
      { lo: 0, hi: 0 },
      { lo: 500, hi: 500 },
    ]);
    const partSplit = normaliseStage(claudeStage([res({ [HAIKU]: mu(1, 1, 0, 500, [100, 300]) })]), COMMITTED).buckets[0]!.tokens;
    expect([partSplit.cache_write_5m_tokens.lo, partSplit.cache_write_1h_tokens.lo, partSplit.cache_write_unsplit_tokens.lo]).toEqual([100, 300, 100]);
  });

  it('an unreported category is unknown, never zero', () => {
    const { outputTokens: _drop, ...noOutput } = mu(1, 1);
    const n = normaliseStage(claudeStage([res({ [HAIKU]: noOutput })]), COMMITTED);
    expect(n.buckets[0]!.tokens.output_tokens).toEqual({ lo: 0, hi: null });
    expect(n.issues.join()).toMatch(/output_tokens not reported/);
  });

  it('an interrupted stage keeps its counts as lower bounds', () => {
    const n = normaliseStage(claudeStage([req('m1', ru(10, 0, 0, 5)), res({ [HAIKU]: mu(10, 5) })], { completeness: 'partial' }), COMMITTED);
    expect(n.completeness).toBe('partial');
    for (const c of CATEGORIES) expect(n.buckets[0]!.tokens[c].hi).toBeNull();
    expect(n.buckets[0]!.tokens.input_tokens.lo).toBe(10);
  });

  it('a stage killed before any result is bounded below by its observed requests', () => {
    const n = normaliseStage(claudeStage([req('m1', ru(10, 0, 0, 5))], { completeness: 'partial' }), COMMITTED);
    expect(n.buckets[0]!.tokens.input_tokens).toEqual({ lo: 10, hi: null });
    expect(n.derivation).toMatch(/observed requests only/);
  });

  it('a stage with no usage is wholly unknown', () => {
    const n = normaliseStage(claudeStage([], { completeness: 'missing' }), COMMITTED);
    expect(n.completeness).toBe('missing');
    for (const c of CATEGORIES) expect(n.buckets[0]!.tokens[c]).toEqual({ lo: 0, hi: null });
  });

  it('requests that exceed the incremental total are flagged and leave the total unbounded', () => {
    const n = normaliseStage(claudeStage([req('m1', ru(50, 0, 0, 5)), res({ [HAIKU]: mu(10, 5) })]), COMMITTED);
    expect(n.buckets[0]!.tokens.input_tokens).toEqual({ lo: 50, hi: null });
    expect(n.issues.join()).toMatch(/exceed the incremental total/);
  });

  it('supports a subset reading of cache reads when configured', () => {
    const sem: UsageSemantics = { ...COMMITTED, 'claude-code': { ...COMMITTED['claude-code'], cacheReadSeparateFromInput: false } };
    const n = normaliseStage(claudeStage([res({ [HAIKU]: mu(100, 1, 40) })]), sem);
    expect(n.buckets[0]!.tokens.input_tokens).toEqual({ lo: 60, hi: 60 });
    expect(n.buckets[0]!.tokens.cached_input_tokens).toEqual({ lo: 40, hi: 40 });
  });
});

describe('Codex normalisation', () => {
  it('with unsettled semantics, reports both readings as bounds and cache writes as unknown', () => {
    const n = normaliseStage(codexStage([cu(24763, 24448, 122, 30)]), UNSETTLED);
    const t = n.buckets[0]!.tokens;
    expect(n.derivation).toMatch(/coincide/);
    expect(t.input_tokens).toEqual({ lo: 315, hi: 24763 });
    expect(t.cached_input_tokens).toEqual({ lo: 24448, hi: 24448 });
    expect(t.output_tokens).toEqual({ lo: 122, hi: 152 });
    expect(t.cache_write_5m_tokens).toEqual({ lo: 0, hi: null });
    expect(t.cache_write_1h_tokens).toEqual({ lo: 0, hi: 0 });
    expect(n.buckets[0]!.prompt).toEqual({ lo: 24763, hi: 24763 + 24448 });
  });

  it('with settled semantics, is exact and mutually exclusive', () => {
    const t = normaliseStage(codexStage([cu(24763, 24448, 122, 30)]), SETTLED).buckets[0]!.tokens;
    expect(t.input_tokens).toEqual({ lo: 315, hi: 315 });
    expect(t.output_tokens).toEqual({ lo: 122, hi: 122 });
    expect(t.cache_write_5m_tokens).toEqual({ lo: 0, hi: 0 });
    const separate = normaliseStage(codexStage([cu(100, 40, 10, 5)]), withCodex({ ...SETTLED.codex, cachedInputSubsetOfInput: false, reasoningIncludedInOutput: false })).buckets[0]!;
    expect(separate.tokens.input_tokens).toEqual({ lo: 100, hi: 100 });
    expect(separate.tokens.output_tokens).toEqual({ lo: 15, hi: 15 });
    expect(separate.prompt).toEqual({ lo: 140, hi: 140 });
  });

  it('per-turn scope sums turns; session-cumulative scope subtracts the prior total', () => {
    const turns = [cu(100, 50, 10, 0), cu(300, 200, 30, 0)];
    const before = cu(80, 40, 5, 0);
    const per = normaliseStage(codexStage(turns, { mode: 'resume', before }), { ...SETTLED, codex: { ...SETTLED.codex, turnCompletedScope: 'per-turn' } }).buckets[0]!.tokens;
    expect(per.output_tokens).toEqual({ lo: 40, hi: 40 });
    const cum = normaliseStage(codexStage(turns, { mode: 'resume', before }), { ...SETTLED, codex: { ...SETTLED.codex, turnCompletedScope: 'session-cumulative' } }).buckets[0]!.tokens;
    expect(cum.output_tokens).toEqual({ lo: 25, hi: 25 });
    expect(cum.cached_input_tokens).toEqual({ lo: 160, hi: 160 });
  });

  it('committed config on a resumed stage: usage is the session total minus the prior total (pilot slot 17)', () => {
    // Counters from a real resumed Codex fix stage (2026-11-20 pilot run, slot 17, irf.CC-CF-CC.off, s3-fix).
    const before = cu(406715, 384640, 8649, 2209);
    const after = cu(655066, 625152, 12020, 3541);
    const n = normaliseStage(codexStage([after], { mode: 'resume', before, after }), COMMITTED);
    const t = n.buckets[0]!.tokens;
    expect(n.derivation).toMatch(/minus the prior session total/);
    expect(t.cached_input_tokens).toEqual({ lo: 240512, hi: 240512 });
    expect(t.input_tokens).toEqual({ lo: 248351 - 240512, hi: 248351 - 240512 });
    expect(t.output_tokens).toEqual({ lo: 3371, hi: 3371 });
  });

  it('unsettled scope on resume: the rollout delta decides when it matches exactly one reading', () => {
    const turns = [cu(100, 50, 10, 0), cu(300, 200, 30, 0)];
    const before = cu(80, 40, 5, 0);
    const n = normaliseStage(codexStage(turns, { mode: 'resume', before, after: cu(480, 290, 45, 0) }), UNSETTLED);
    expect(n.derivation).toMatch(/matches the per-turn reading only/);
    expect(n.buckets[0]!.tokens.cached_input_tokens).toEqual({ lo: 250, hi: 250 });
    expect(n.crossCheck.status).toBe('agrees');
  });

  it('unsettled scope on resume without a deciding rollout: bounded by both readings', () => {
    const turns = [cu(100, 50, 10, 0), cu(300, 200, 30, 0)];
    const n = normaliseStage(codexStage(turns, { mode: 'resume', before: cu(80, 40, 5, 0) }), UNSETTLED);
    expect(n.derivation).toMatch(/bounded by both readings/);
    expect(n.buckets[0]!.tokens.cached_input_tokens).toEqual({ lo: 160, hi: 250 });
    const noPrior = normaliseStage(codexStage(turns, { mode: 'resume' }), UNSETTLED);
    expect(noPrior.buckets[0]!.tokens.cached_input_tokens).toEqual({ lo: 0, hi: 250 });
  });

  it('missing usage is unknown; a partial stage is a lower bound', () => {
    const missing = normaliseStage(codexStage([], { completeness: 'missing' }), SETTLED);
    expect(missing.completeness).toBe('missing');
    for (const c of CATEGORIES) expect(missing.buckets[0]!.tokens[c].hi).toBeNull();
    const partial = normaliseStage(codexStage([cu(100, 40, 10, 0)], { completeness: 'partial' }), SETTLED);
    expect(partial.buckets[0]!.tokens.input_tokens).toEqual({ lo: 60, hi: null });
    expect(partial.buckets[0]!.prompt.hi).toBeNull();
  });

  it('a missing counter in any turn is unknown', () => {
    const n = normaliseStage(codexStage([cu(100, 40, 10, 0), { input_tokens: 5, output_tokens: 1 }]), SETTLED);
    expect(n.buckets[0]!.tokens.cached_input_tokens).toEqual({ lo: 0, hi: null });
    expect(n.issues.join()).toMatch(/cached_input_tokens missing/);
  });
});

describe('normalisation properties', () => {
  const tri = fc.constantFrom(true, false, null);
  const sem = fc.record({
    status: fc.constant('x'),
    turnCompletedScope: fc.constantFrom('per-turn' as const, 'session-cumulative' as const, null),
    cachedInputSubsetOfInput: tri,
    reasoningIncludedInOutput: tri,
    cacheWrites: fc.constantFrom('not-reported' as const, 'verified-not-billed' as const),
  });
  const n = fc.nat({ max: 5_000_000 });
  const turn = fc.record({ input_tokens: n, cached_input_tokens: n, output_tokens: n, reasoning_output_tokens: n });

  it('Codex: every category and prompt is a well-formed non-negative interval', () => {
    fc.assert(
      fc.property(sem, fc.array(turn, { minLength: 1, maxLength: 5 }), fc.constantFrom('fresh', 'resume'), fc.option(turn), fc.option(turn), fc.constantFrom('complete', 'partial'), (s, turns, mode, before, after, completeness) => {
        const out = normaliseStage(codexStage(turns, { mode, before, after, completeness }), withCodex(s));
        for (const b of out.buckets) {
          for (const c of CATEGORIES) expect(wellFormed(b.tokens[c])).toBe(true);
          expect(wellFormed(b.prompt)).toBe(true);
        }
      }),
    );
  });

  it('Codex: with a settled per-turn reading the total equals the sum of the turns', () => {
    fc.assert(
      fc.property(fc.array(turn, { minLength: 1, maxLength: 6 }), (turns) => {
        const t = normaliseStage(codexStage(turns), withCodex({ ...SETTLED.codex, cachedInputSubsetOfInput: false, reasoningIncludedInOutput: false })).buckets[0]!.tokens;
        const sum = (k: keyof ReturnType<typeof cu>) => turns.reduce((a, u) => a + u[k], 0);
        expect(t.input_tokens).toEqual({ lo: sum('input_tokens'), hi: sum('input_tokens') });
        expect(t.output_tokens.lo).toBe(sum('output_tokens') + sum('reasoning_output_tokens'));
      }),
    );
  });

  it('Claude: resumed incremental counters sum regardless of how they are split across results', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(n, n, n, n), { minLength: 1, maxLength: 6 }), (parts) => {
        const one = normaliseStage(claudeStage(parts.map(([i, o, r, w]) => res({ [HAIKU]: mu(i, o, r, w) }))), COMMITTED).buckets[0]!.tokens;
        const total = parts.reduce((a, [i, o, r, w]) => [a[0]! + i, a[1]! + o, a[2]! + r, a[3]! + w], [0, 0, 0, 0]);
        expect(one.input_tokens.lo).toBe(total[0]);
        expect(one.output_tokens.lo).toBe(total[1]);
        expect(one.cached_input_tokens.lo).toBe(total[2]);
        expect(one.cache_write_5m_tokens.lo).toBe(total[3]);
      }),
    );
  });

  it('never throws on malformed records, and only well-formed intervals come out', () => {
    fc.assert(
      fc.property(fc.anything(), fc.constantFrom('codex', 'claude-code', 'other'), fc.anything(), (raw, tool, supplementary) => {
        const out = normaliseStage({ tool, requestedModel: 'm', usage: { completeness: 'complete', raw: Array.isArray(raw) ? raw : [raw], supplementary } }, COMMITTED);
        for (const b of out.buckets) for (const c of CATEGORIES) expect(wellFormed(b.tokens[c])).toBe(true);
      }),
    );
    expect(() => normaliseStage(null, COMMITTED)).not.toThrow();
    const junk = normaliseStage('junk', COMMITTED);
    expect(junk.tool).toBe('unknown');
    // Unrecognised records are unknown usage, never an empty (zero-cost) stage.
    for (const c of CATEGORIES) expect(junk.buckets[0]!.tokens[c]).toEqual({ lo: 0, hi: null });
  });

  it('copies only numeric counters and model names: injected text never reaches the output (sanitisation)', () => {
    const MARK = 'SECRET-MARKER-9f1c';
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), n, n, (junk, a, b) => {
        const usage = { ...ru(a, b, 0, 1), note: `${MARK}${junk}`, prompt: MARK };
        const since = { [HAIKU]: { ...mu(a, 1, b, 0), text: MARK } };
        const out = JSON.stringify(normaliseStage(claudeStage([req('m1', usage), { ...res(since), result: MARK }]), COMMITTED));
        expect(out).not.toContain(MARK);
        const codexOut = JSON.stringify(normaliseStage(codexStage([{ ...cu(a, 0, b, 0), message: MARK }]), COMMITTED));
        expect(codexOut).not.toContain(MARK);
      }),
    );
  });
});
