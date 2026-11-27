/**
 * Native usage counters → mutually exclusive cost.dev categories, per stage and per serving model
 * (methodology section 10). Pure; reads only the numeric counters the adapters saved in
 * `stage.json` (`usage.raw` and `usage.supplementary`), never prompt text.
 *
 * - Claude Code: a stage's totals are the sum of its own results' incremental
 *   `model_usage_since_last_result`, per model. Cumulative `modelUsage` before/after is a cross-check
 *   only. Deduplicated assistant-message usage gives per-request prompt lengths for prompt-length
 *   tiers; usage not attributable to an observed request (auxiliary calls, truncated streaming
 *   counts) stays in the bucket total and is tiered conservatively at valuation.
 * - Codex: `turn.completed.usage` per turn. Counter semantics come from config/usage-semantics.json;
 *   an unsettled semantics yields both readings as lower/upper bounds, never a guess.
 * - Missing categories are unknown, an interrupted stage keeps its counts as lower bounds, and a
 *   stage with no usage at all is wholly unknown.
 */
import {
  CATEGORIES,
  UNKNOWN,
  add,
  exact,
  fromExact,
  unknownVector,
  vector,
  zeroExact,
  type Category,
  type ExactVector,
  type Quantity,
  type TokenVector,
} from './quantity.ts';

export interface CodexSemantics {
  status: string;
  turnCompletedScope: 'per-turn' | 'session-cumulative' | null;
  cachedInputSubsetOfInput: boolean | null;
  reasoningIncludedInOutput: boolean | null;
  cacheWrites: 'not-reported' | 'verified-not-billed';
}

export interface ClaudeSemantics {
  status: string;
  cacheReadSeparateFromInput: boolean;
}

export interface UsageSemantics {
  codex: CodexSemantics;
  'claude-code': ClaudeSemantics;
}

/** Pure: validate the semantics config so a typo cannot silently change the accounting. */
export function parseUsageSemantics(v: unknown): UsageSemantics {
  const o = v as Record<string, Record<string, unknown>> | null;
  const c = o?.codex;
  const a = o?.['claude-code'];
  const triBool = (x: unknown) => x === null || typeof x === 'boolean';
  if (!c || !a) throw new Error('usage semantics needs codex and claude-code sections');
  if (!(c.turnCompletedScope === null || c.turnCompletedScope === 'per-turn' || c.turnCompletedScope === 'session-cumulative')) throw new Error('codex.turnCompletedScope');
  if (!triBool(c.cachedInputSubsetOfInput) || !triBool(c.reasoningIncludedInOutput)) throw new Error('codex boolean semantics must be true, false or null');
  if (c.cacheWrites !== 'not-reported' && c.cacheWrites !== 'verified-not-billed') throw new Error('codex.cacheWrites');
  if (typeof a.cacheReadSeparateFromInput !== 'boolean') throw new Error('claude-code.cacheReadSeparateFromInput');
  return {
    codex: { status: String(c.status), turnCompletedScope: c.turnCompletedScope, cachedInputSubsetOfInput: c.cachedInputSubsetOfInput as boolean | null, reasoningIncludedInOutput: c.reasoningIncludedInOutput as boolean | null, cacheWrites: c.cacheWrites },
    'claude-code': { status: String(a.status), cacheReadSeparateFromInput: a.cacheReadSeparateFromInput },
  };
}

/** One observed request whose prompt length is known; its counts are part of the bucket total. */
export interface RequestUsage {
  id: string;
  prompt: number;
  tokens: ExactVector;
}

export interface UsageBucket {
  model: string;
  /** Any model other than the stage's requested model. */
  auxiliary: boolean;
  tokens: TokenVector;
  /** Total prompt tokens (input-side categories) over every request of this model in the stage. */
  prompt: Quantity;
  requests: RequestUsage[];
}

export interface NormalisedStage {
  tool: 'codex' | 'claude-code' | 'unknown';
  requestedModel: string | null;
  completeness: 'complete' | 'partial' | 'missing';
  /** How the stage total was derived from the counters. */
  derivation: string;
  semanticsStatus: string;
  buckets: UsageBucket[];
  /** Cumulative-counter cross-check (Claude Code) or rollout cross-check (Codex). */
  crossCheck: { status: 'agrees' | 'differs' | 'unavailable'; detail: string | null };
  issues: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const q = (n: number | null): Quantity => (n === null ? { ...UNKNOWN } : exact(n));

/** Interval `a - b`, clamped at zero. */
function sub(a: Quantity, b: Quantity): Quantity {
  return { lo: b.hi === null ? 0 : Math.max(0, a.lo - b.hi), hi: a.hi === null ? null : Math.max(0, a.hi - b.lo) };
}
const hull = (a: Quantity, b: Quantity): Quantity => ({ lo: Math.min(a.lo, b.lo), hi: a.hi === null || b.hi === null ? null : Math.max(a.hi, b.hi) });
const unbounded = (x: Quantity): Quantity => ({ lo: x.lo, hi: null });

/** Pure: entry point. Never throws on a malformed record; it reports issues and unknowns instead. */
export function normaliseStage(stage: unknown, semantics: UsageSemantics): NormalisedStage {
  const s = isObj(stage) ? stage : {};
  const usage = isObj(s.usage) ? s.usage : {};
  const requestedModel = typeof s.requestedModel === 'string' ? s.requestedModel : null;
  const declared = usage.completeness === 'complete' || usage.completeness === 'partial' ? usage.completeness : 'missing';
  const raw = Array.isArray(usage.raw) ? usage.raw : [];
  const supp = isObj(usage.supplementary) ? usage.supplementary : {};
  if (s.tool === 'codex') return normaliseCodex({ requestedModel, declared, raw, supp, mode: s.mode === 'resume' ? 'resume' : 'fresh', resolvedModel: typeof s.resolvedModel === 'string' ? s.resolvedModel : null }, semantics.codex);
  if (s.tool === 'claude-code') return normaliseClaude({ requestedModel, declared, raw, supp }, semantics['claude-code']);
  return { tool: 'unknown', requestedModel, completeness: 'missing', derivation: 'unrecognised stage record', semanticsStatus: 'n/a', buckets: [{ model: requestedModel ?? 'unknown', auxiliary: false, tokens: unknownVector(), prompt: { ...UNKNOWN }, requests: [] }], crossCheck: { status: 'unavailable', detail: null }, issues: ['stage record has no recognised tool; usage unknown'] };
}

// ---------------------------------------------------------------- Codex

interface CodexCounts {
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
}
const CODEX_KEYS: Array<[keyof CodexCounts, string]> = [
  ['input', 'input_tokens'],
  ['cached', 'cached_input_tokens'],
  ['output', 'output_tokens'],
  ['reasoning', 'reasoning_output_tokens'],
];
const codexCounts = (u: Record<string, unknown>): CodexCounts => Object.fromEntries(CODEX_KEYS.map(([k, n]) => [k, count(u[n])])) as unknown as CodexCounts;
const sameCounts = (a: CodexCounts, b: CodexCounts) => CODEX_KEYS.every(([k]) => a[k] === b[k]);
const countsQ = (c: CodexCounts): Record<keyof CodexCounts, Quantity> => Object.fromEntries(CODEX_KEYS.map(([k]) => [k, q(c[k])])) as Record<keyof CodexCounts, Quantity>;

function sumCounts(cs: CodexCounts[]): CodexCounts {
  const out: CodexCounts = { input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const c of cs) for (const [k] of CODEX_KEYS) out[k] = out[k] === null || c[k] === null ? null : out[k]! + c[k]!;
  return out;
}

/** `after - before` per counter; null where either side is missing or the difference is negative. */
function deltaCounts(after: CodexCounts, before: CodexCounts): CodexCounts {
  const out = {} as CodexCounts;
  for (const [k] of CODEX_KEYS) {
    const d = after[k] === null || before[k] === null ? null : after[k]! - before[k]!;
    out[k] = d === null || d < 0 ? null : d;
  }
  return out;
}

function normaliseCodex(i: { requestedModel: string | null; declared: NormalisedStage['completeness']; raw: unknown[]; supp: Record<string, unknown>; mode: 'fresh' | 'resume'; resolvedModel: string | null }, sem: CodexSemantics): NormalisedStage {
  const issues: string[] = [];
  const turns = i.raw.filter(isObj).map(codexCounts);
  if (turns.length !== i.raw.length) issues.push(`${i.raw.length - turns.length} non-object usage entries ignored`);
  const model = i.resolvedModel ?? i.requestedModel ?? 'unknown';
  const base = { tool: 'codex' as const, requestedModel: i.requestedModel, semanticsStatus: sem.status };
  const before = isObj(i.supp.rolloutCumulativeBefore) ? codexCounts(i.supp.rolloutCumulativeBefore) : null;
  const after = isObj(i.supp.rolloutCumulativeAfter) ? codexCounts(i.supp.rolloutCumulativeAfter) : null;
  if (turns.length === 0 || i.declared === 'missing') {
    return { ...base, completeness: 'missing', derivation: 'no turn.completed usage', buckets: [{ model, auxiliary: model !== i.requestedModel, tokens: unknownVector(), prompt: { ...UNKNOWN }, requests: [] }], crossCheck: { status: 'unavailable', detail: null }, issues: [...issues, 'no usage captured; every category unknown'] };
  }

  // Candidate stage totals under each scope reading.
  const perTurn = sumCounts(turns);
  const priorTotal: CodexCounts | null = i.mode === 'fresh' ? { input: 0, cached: 0, output: 0, reasoning: 0 } : before;
  const cumulative = priorTotal ? deltaCounts(turns[turns.length - 1]!, priorTotal) : null;
  const rollout = after && before ? deltaCounts(after, before) : after && i.mode === 'fresh' ? after : null;

  let totals: Record<keyof CodexCounts, Quantity>;
  let derivation: string;
  if (sem.turnCompletedScope === 'per-turn') {
    totals = countsQ(perTurn);
    derivation = 'turn.completed usage summed (per-turn, configured)';
  } else if (sem.turnCompletedScope === 'session-cumulative') {
    totals = cumulative ? countsQ(cumulative) : Object.fromEntries(CODEX_KEYS.map(([k]) => [k, { lo: 0, hi: perTurn[k] }])) as Record<keyof CodexCounts, Quantity>;
    derivation = cumulative ? 'last turn.completed usage minus the prior session total (session-cumulative, configured)' : 'session-cumulative configured but prior session total unavailable; bounded by the last reading';
    if (!cumulative) issues.push('prior cumulative total unavailable for a resumed stage');
  } else if (cumulative && sameCounts(perTurn, cumulative)) {
    totals = countsQ(perTurn);
    derivation = 'scope unverified; per-turn and session-cumulative readings coincide';
  } else if (cumulative && rollout && sameCounts(rollout, perTurn) !== sameCounts(rollout, cumulative)) {
    const pick = sameCounts(rollout, perTurn) ? perTurn : cumulative;
    totals = countsQ(pick);
    derivation = `scope unverified; rollout token_count delta matches the ${pick === perTurn ? 'per-turn' : 'session-cumulative'} reading only`;
  } else if (cumulative) {
    totals = Object.fromEntries(CODEX_KEYS.map(([k]) => [k, hull(q(perTurn[k]), q(cumulative[k]))])) as Record<keyof CodexCounts, Quantity>;
    derivation = 'scope unverified and readings differ; bounded by both readings';
  } else {
    // Resumed with no prior total: the invocation used at most the summed readings.
    totals = Object.fromEntries(CODEX_KEYS.map(([k]) => [k, { lo: 0, hi: perTurn[k] }])) as Record<keyof CodexCounts, Quantity>;
    derivation = 'scope unverified and prior session total unavailable; bounded above by the summed readings';
  }
  for (const [k, n] of CODEX_KEYS) if (perTurn[k] === null) issues.push(`${n} missing from at least one turn; unknown`);

  const { input: I, cached: C, output: O, reasoning: R } = totals;
  const subset = sub(I, C);
  const input = sem.cachedInputSubsetOfInput === true ? subset : sem.cachedInputSubsetOfInput === false ? I : { lo: subset.lo, hi: I.hi };
  const output = sem.reasoningIncludedInOutput === true ? O : sem.reasoningIncludedInOutput === false ? add(O, R) : { lo: O.lo, hi: add(O, R).hi };
  const prompt = sem.cachedInputSubsetOfInput === true ? I : sem.cachedInputSubsetOfInput === false ? add(I, C) : { lo: I.lo, hi: add(I, C).hi };
  let tokens: TokenVector = {
    input_tokens: input,
    cached_input_tokens: C,
    cache_write_5m_tokens: sem.cacheWrites === 'verified-not-billed' ? exact(0) : { ...UNKNOWN },
    // OpenAI books publish no 1-hour cache-write dimension; Codex has no such TTL to report.
    cache_write_1h_tokens: exact(0),
    output_tokens: output,
    cache_write_unsplit_tokens: exact(0),
  };
  let promptQ = prompt;
  if (i.declared === 'partial') {
    tokens = vector((c) => unbounded(tokens[c]));
    promptQ = unbounded(prompt);
    issues.push('stage interrupted or incomplete; counts are lower bounds');
  }
  const crossCheck: NormalisedStage['crossCheck'] = rollout ? (CODEX_KEYS.every(([k]) => rollout[k] === null || (totals[k].lo <= rollout[k]! && rollout[k]! <= (totals[k].hi ?? Infinity))) ? { status: 'agrees', detail: 'rollout token_count delta lies within the stage totals' } : { status: 'differs', detail: `rollout delta ${JSON.stringify(rollout)}` }) : { status: 'unavailable', detail: null };
  return { ...base, completeness: i.declared, derivation, buckets: [{ model, auxiliary: model !== i.requestedModel, tokens, prompt: promptQ, requests: [] }], crossCheck, issues };
}

// ---------------------------------------------------------------- Claude Code

type Nullable = Record<Category, number | null>;

function claudeModelEntry(m: Record<string, unknown>, sem: ClaudeSemantics, issues: string[]): Nullable {
  const input = count(m.inputTokens);
  const cached = count(m.cacheReadInputTokens);
  const cw = count(m.cacheCreationInputTokens);
  const e5 = count(m.cacheCreationEphemeral5mInputTokens);
  const e1 = count(m.cacheCreationEphemeral1hInputTokens);
  return { ...splitWrites(cw, e5, e1, issues), input_tokens: exclusiveInput(input, cached, sem, issues), cached_input_tokens: cached, output_tokens: count(m.outputTokens) };
}

function claudeRequestEntry(u: Record<string, unknown>, sem: ClaudeSemantics, issues: string[]): Nullable {
  const input = count(u.input_tokens);
  const cached = count(u.cache_read_input_tokens);
  const cc = isObj(u.cache_creation) ? u.cache_creation : {};
  return { ...splitWrites(count(u.cache_creation_input_tokens), count(cc.ephemeral_5m_input_tokens), count(cc.ephemeral_1h_input_tokens), issues), input_tokens: exclusiveInput(input, cached, sem, issues), cached_input_tokens: cached, output_tokens: count(u.output_tokens) };
}

function exclusiveInput(input: number | null, cached: number | null, sem: ClaudeSemantics, issues: string[]): number | null {
  if (sem.cacheReadSeparateFromInput || input === null) return input;
  if (cached === null) return null;
  if (cached > input) {
    issues.push('cache reads exceed input under the subset reading');
    return null;
  }
  return input - cached;
}

function splitWrites(cw: number | null, e5: number | null, e1: number | null, issues: string[]): Pick<Nullable, 'cache_write_5m_tokens' | 'cache_write_1h_tokens' | 'cache_write_unsplit_tokens'> {
  if (cw === null) return { cache_write_5m_tokens: null, cache_write_1h_tokens: null, cache_write_unsplit_tokens: null };
  if (e5 === null || e1 === null) return { cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, cache_write_unsplit_tokens: cw };
  if (e5 + e1 > cw) {
    issues.push('cache-write TTL split exceeds the cache-write total');
    return { cache_write_5m_tokens: null, cache_write_1h_tokens: null, cache_write_unsplit_tokens: null };
  }
  return { cache_write_5m_tokens: e5, cache_write_1h_tokens: e1, cache_write_unsplit_tokens: cw - e5 - e1 };
}

const promptOf = (v: ExactVector) => v.input_tokens + v.cached_input_tokens + v.cache_write_5m_tokens + v.cache_write_1h_tokens + v.cache_write_unsplit_tokens;
const promptQ = (t: TokenVector): Quantity => ['input_tokens', 'cached_input_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_unsplit_tokens'].reduce((acc, c) => add(acc, t[c as Category]), exact(0));
const CW: Category[] = ['cache_write_5m_tokens', 'cache_write_1h_tokens', 'cache_write_unsplit_tokens'];

function normaliseClaude(i: { requestedModel: string | null; declared: NormalisedStage['completeness']; raw: unknown[]; supp: Record<string, unknown> }, sem: ClaudeSemantics): NormalisedStage {
  const issues: string[] = [];
  const base = { tool: 'claude-code' as const, requestedModel: i.requestedModel, semanticsStatus: sem.status };
  const entries = i.raw.filter(isObj);

  // Per-request usage (prompt lengths for tiers).
  const requests = new Map<string, RequestUsage[]>();
  let unattributable = 0;
  for (const e of entries.filter((x) => x.kind === 'request')) {
    if (typeof e.model !== 'string' || !isObj(e.usage)) {
      unattributable++;
      continue;
    }
    const v = claudeRequestEntry(e.usage, sem, issues);
    if (CATEGORIES.some((c) => v[c] === null)) {
      unattributable++;
      continue;
    }
    const ex = v as ExactVector;
    const list = requests.get(e.model) ?? [];
    list.push({ id: typeof e.messageId === 'string' ? e.messageId : `request-${list.length + 1}`, prompt: promptOf(ex), tokens: ex });
    requests.set(e.model, list);
  }
  if (unattributable) issues.push(`${unattributable} request usage entries lacked counters; their usage is covered only by the result totals`);

  // Stage totals: Σ results' incremental counters, per model.
  const results = entries.filter((x) => x.kind === 'result');
  const incremental = results.filter((r) => isObj(r.sinceLastResult));
  const totals = new Map<string, Nullable>();
  for (const r of incremental) {
    for (const [model, m] of Object.entries(r.sinceLastResult as Record<string, unknown>)) {
      if (!isObj(m)) {
        issues.push(`non-object incremental usage for ${model}`);
        totals.set(model, Object.fromEntries(CATEGORIES.map((c) => [c, null])) as Nullable);
        continue;
      }
      const v = claudeModelEntry(m, sem, issues);
      const prev = totals.get(model);
      totals.set(model, prev ? (Object.fromEntries(CATEGORIES.map((c) => [c, prev[c] === null || v[c] === null ? null : prev[c]! + v[c]!])) as Nullable) : v);
    }
  }
  const haveTotals = incremental.length > 0;
  const completeness: NormalisedStage['completeness'] = i.declared === 'missing' || (!haveTotals && requests.size === 0) ? 'missing' : i.declared;
  if (completeness === 'missing') {
    const model = i.requestedModel ?? 'unknown';
    return { ...base, completeness, derivation: 'no usage counters', buckets: [{ model, auxiliary: false, tokens: unknownVector(), prompt: { ...UNKNOWN }, requests: [] }], crossCheck: { status: 'unavailable', detail: null }, issues: [...issues, 'no usage captured; every category unknown'] };
  }

  const models = [...new Set([...totals.keys(), ...requests.keys()])].sort();
  const buckets: UsageBucket[] = models.map((model) => {
    const reqs = requests.get(model) ?? [];
    const reqSum = zeroExact();
    for (const r of reqs) for (const c of CATEGORIES) reqSum[c] += r.tokens[c];
    let tokens: TokenVector;
    const t = totals.get(model);
    if (!haveTotals) {
      tokens = vector((c) => ({ lo: reqSum[c], hi: null }));
    } else if (!t) {
      issues.push(`${model} appears in request usage but not in the incremental totals`);
      tokens = vector((c) => ({ lo: reqSum[c], hi: null }));
    } else {
      tokens = vector((c) => q(t[c]));
      // The TTL split may differ between per-request and total counters; compare cache writes pooled.
      const pooledTotal = CW.reduce((a, c) => (a === null || t[c] === null ? null : a + t[c]!), 0 as number | null);
      const pooledReq = CW.reduce((a, c) => a + reqSum[c], 0);
      for (const c of CATEGORIES) {
        const short = CW.includes(c) ? pooledTotal !== null && pooledTotal < pooledReq : t[c] !== null && t[c]! < reqSum[c];
        if (short) {
          issues.push(`${model} ${c}: observed requests exceed the incremental total`);
          tokens[c] = { lo: Math.max(tokens[c].lo, reqSum[c]), hi: null };
        }
      }
    }
    if (completeness === 'partial') tokens = vector((c) => unbounded(tokens[c]));
    for (const c of CATEGORIES) if (t && t[c] === null) issues.push(`${model} ${c} not reported; unknown`);
    return { model, auxiliary: model !== i.requestedModel, tokens, prompt: promptQ(tokens), requests: reqs };
  });
  if (completeness === 'partial') issues.push('stage interrupted or incomplete; counts are lower bounds');

  return { ...base, completeness, derivation: haveTotals ? `sum of ${incremental.length} result model_usage_since_last_result counter(s)${incremental.length < results.length ? `; ${results.length - incremental.length} result(s) without one` : ''}` : 'no incremental totals; observed requests only (lower bounds)', buckets, crossCheck: claudeCrossCheck(i.supp, totals, sem), issues: [...new Set(issues)] };
}

/** Pure: cumulative `modelUsage` after − before against the summed incremental totals. */
function claudeCrossCheck(supp: Record<string, unknown>, totals: Map<string, Nullable>, sem: ClaudeSemantics): NormalisedStage['crossCheck'] {
  const after = isObj(supp.cumulativeAfter) ? supp.cumulativeAfter : null;
  if (!after || totals.size === 0) return { status: 'unavailable', detail: null };
  const before = isObj(supp.cumulativeBefore) ? supp.cumulativeBefore : {};
  const scratch: string[] = [];
  const diffs: string[] = [];
  for (const model of new Set([...Object.keys(after), ...totals.keys()])) {
    const a = isObj(after[model]) ? claudeModelEntry(after[model] as Record<string, unknown>, sem, scratch) : null;
    const b = isObj(before[model]) ? claudeModelEntry(before[model] as Record<string, unknown>, sem, scratch) : null;
    const t = totals.get(model);
    for (const c of ['input_tokens', 'cached_input_tokens', 'output_tokens'] as Category[]) {
      const d = a?.[c] == null ? null : a[c]! - (b?.[c] ?? 0);
      if (d !== (t?.[c] ?? 0)) diffs.push(`${model} ${c}: cumulative delta ${d}, incremental ${t?.[c] ?? 0}`);
    }
  }
  return diffs.length ? { status: 'differs', detail: diffs.join('; ') } : { status: 'agrees', detail: 'cumulative modelUsage delta equals the summed incremental counters' };
}

