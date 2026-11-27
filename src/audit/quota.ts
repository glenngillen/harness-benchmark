/**
 * Quota-misclassification audit (methodology section 8). The adapters recognise quota exhaustion by
 * matching client error text, and the pilots never hit a quota, so that recognition is unobserved.
 * After a scored block is fetched, every scored-failure attempt's records are scanned with a frozen
 * pattern list broader than the adapters' (config/quota-audit.json). Each match becomes a flag with
 * a scrubbed excerpt and a decision that stays `pending` until a person records `reclassified` or
 * `dismissed` with a reason.
 *
 * Rules this module enforces:
 * - A flag exists only where a pattern matched text in the attempt's own records. The scan never
 *   reads the outcome, verdict, condition or quality; it only labels flags with slot and attempt.
 * - A `reclassified` decision turns the attempt into operational `quota-exhausted` through an overlay
 *   (`applyAudit`): attempt.json is never rewritten, usage is kept, and the overlay links the flags.
 * - Every matched location is kept as a flag; nothing is capped, so later evidence is never dropped.
 * - A block audit with any pending flag, or with a scored failure it never scanned, is incomplete.
 *
 * Pure: the CLI (src/cli/audit-block.ts) and src/audit/files.ts do the reading and writing.
 */
import { createHash } from 'node:crypto';
import { scrubSecrets } from '../adapters/scrub.ts';
import type { AttemptRecord } from '../orchestrator/state.ts';

export const AUDIT_SCHEMA = 'harness-benchmark/quota-audit@1';
export const PATTERNS_SCHEMA = 'harness-benchmark/quota-audit-patterns@1';
/** Rule id for a structured Claude `rate_limit_event` whose status is not `allowed`. */
export const RATE_LIMIT_STATUS_RULE = 'claude-rate-limit-status';

export interface QuotaPattern {
  id: string;
  regex: RegExp;
}

export interface QuotaPatterns {
  excerptChars: number;
  /**
   * How many flags per attempt the CLI prints. Display only: the audit keeps every flag. (An
   * earlier `maxFlagsPerSource` capped the flags themselves and is rejected, so a config with that
   * meaning cannot run under this scanner.)
   */
  consoleFlagsPerAttempt: number;
  patterns: QuotaPattern[];
}

/** Validate config/quota-audit.json. Throws on anything malformed: a broken pattern list must not pass silently. */
export function parseQuotaPatterns(raw: unknown): QuotaPatterns {
  const o = raw as { schema?: unknown; excerptChars?: unknown; consoleFlagsPerAttempt?: unknown; maxFlagsPerSource?: unknown; patterns?: unknown };
  if (!o || typeof o !== 'object') throw new Error('quota audit patterns: not an object');
  if (o.schema !== PATTERNS_SCHEMA) throw new Error(`quota audit patterns: schema must be ${PATTERNS_SCHEMA}`);
  if ('maxFlagsPerSource' in o) throw new Error('quota audit patterns: maxFlagsPerSource is no longer supported; the audit keeps every flag (use consoleFlagsPerAttempt to limit console output)');
  const posInt = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`quota audit patterns: ${name} must be a positive integer`);
    return v;
  };
  if (!Array.isArray(o.patterns) || o.patterns.length === 0) throw new Error('quota audit patterns: patterns must be a non-empty array');
  const seen = new Set<string>();
  const patterns = o.patterns.map((p: { id?: unknown; regex?: unknown }, i) => {
    if (typeof p?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new Error(`quota audit patterns: pattern ${i} has no valid id`);
    if (seen.has(p.id) || p.id === RATE_LIMIT_STATUS_RULE) throw new Error(`quota audit patterns: duplicate or reserved id ${p.id}`);
    seen.add(p.id);
    if (typeof p.regex !== 'string' || p.regex.length === 0) throw new Error(`quota audit patterns: ${p.id} has no regex`);
    const regex = new RegExp(p.regex, 'i');
    if (regex.test('')) throw new Error(`quota audit patterns: ${p.id} matches the empty string`);
    return { id: p.id, regex };
  });
  return { excerptChars: posInt(o.excerptChars, 'excerptChars'), consoleFlagsPerAttempt: posInt(o.consoleFlagsPerAttempt, 'consoleFlagsPerAttempt'), patterns };
}

export type SourceKind = 'stderr' | 'events' | 'final-message' | 'termination';

/** One piece of an attempt's own records. `file` is relative to the benchmark root. */
export interface EvidenceSource {
  kind: SourceKind;
  file: string;
  /** For `termination`: the field the text came from (for example `terminationDetail`). */
  field?: string;
  text: string;
}

export interface Match {
  /** Every rule that matched this location (one flag per location, not per rule). */
  rules: string[];
  /** Where in the file: `line N`, `line N $.path`, or a field name. */
  locator: string;
  excerpt: string;
}

/** A single-line, scrubbed window of `text` around [start, end), at most `chars` long plus ellipses. */
export function excerptAround(text: string, start: number, end: number, chars: number): string {
  const len = Math.max(0, end - start);
  const room = Math.max(0, chars - len);
  let from = Math.max(0, start - Math.floor(room / 2));
  const to = Math.min(text.length, Math.max(end, from + chars));
  from = Math.max(0, Math.min(from, to - chars));
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  const clipped = `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
  return scrubSecrets(clipped);
}

/** At most one match per line: every rule that matched, with the excerpt centred on the earliest match. */
function matchLine(line: string, locator: string, p: QuotaPatterns): Match[] {
  const rules: string[] = [];
  let first: { start: number; end: number } | null = null;
  for (const { id, regex } of p.patterns) {
    const m = regex.exec(line);
    if (!m) continue;
    rules.push(id);
    if (!first || m.index < first.start) first = { start: m.index, end: m.index + m[0].length };
  }
  return first ? [{ rules, locator, excerpt: excerptAround(line, first.start, first.end, p.excerptChars) }] : [];
}

/** Scan plain text line by line. */
export function scanText(text: string, p: QuotaPatterns, locatorPrefix = 'line'): Match[] {
  const out: Match[] = [];
  text.split('\n').forEach((line, i) => out.push(...matchLine(line, `${locatorPrefix} ${i + 1}`, p)));
  return out;
}

const CODEX_CONTENT_ITEMS = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type EventTreatment = { kind: 'skip' } | { kind: 'flag'; rule: string; text: string } | { kind: 'scan'; values: Array<{ path: string; text: string }> };

/**
 * How one parsed event is audited. Model- and tool-authored content is skipped: it cannot evidence a
 * provider limit, and a coding task's own code and test output would otherwise drown the flags.
 * Everything else (client errors, including Claude's client-generated assistant error messages,
 * retries, results, unknown event types) is scanned.
 */
export function eventTreatment(event: unknown): EventTreatment {
  if (!isObj(event)) return { kind: 'scan', values: leafValues(event, '$') };
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'rate_limit_event') {
    const info = isObj(event.rate_limit_info) ? event.rate_limit_info : null;
    if (info && info.status === 'allowed') return { kind: 'skip' };
    return { kind: 'flag', rule: RATE_LIMIT_STATUS_RULE, text: JSON.stringify(info ?? event) };
  }
  // Claude Code reports some API failures as client-generated assistant messages (`error` set,
  // `is_api_error_message: true`, or the `<synthetic>` model), the same shape parseClaudeEvents
  // records as an API error. Those are client text, not model output, so they are scanned.
  if (type === 'assistant' && isClientAssistantError(event)) return { kind: 'scan', values: leafValues(event, '$') };
  if (type === 'assistant' || type === 'user') return { kind: 'skip' };
  if (type === 'system' && event.subtype === 'init') return { kind: 'skip' };
  if (/^item\./.test(type) && isObj(event.item) && typeof event.item.type === 'string' && CODEX_CONTENT_ITEMS.has(event.item.type)) return { kind: 'skip' };
  return { kind: 'scan', values: leafValues(event, '$') };
}

/** A Claude assistant event generated by the client to report an API error rather than authored by the model. */
export function isClientAssistantError(event: Record<string, unknown>): boolean {
  if (event.error !== undefined || event.is_api_error_message === true) return true;
  return isObj(event.message) && event.message.model === '<synthetic>';
}

/** String values anywhere, plus numeric values of fields named like a status or code. Keys are not scanned. */
export function leafValues(v: unknown, path: string, key = ''): Array<{ path: string; text: string }> {
  if (typeof v === 'string') return v.length ? [{ path, text: v }] : [];
  if (typeof v === 'number') return /status|code/i.test(key) && Number.isFinite(v) ? [{ path, text: String(v) }] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => leafValues(x, `${path}[${i}]`, key));
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => leafValues(x, `${path}.${k}`, k));
  return [];
}

/** Scan an events.jsonl stream. Lines that are not JSON are scanned as text. */
export function scanEvents(text: string, p: QuotaPatterns): Match[] {
  const out: Match[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const loc = `line ${i + 1}`;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      out.push(...matchLine(line, loc, p));
      return;
    }
    const t = eventTreatment(event);
    if (t.kind === 'flag') out.push({ rules: [t.rule], locator: loc, excerpt: excerptAround(t.text, 0, 0, p.excerptChars) });
    else if (t.kind === 'scan') for (const v of t.values) for (const l of v.text.split('\n')) out.push(...matchLine(l, `${loc} ${v.path}`, p));
  });
  return out;
}

/**
 * Every match in one source. Nothing is capped: a later match may be the only quota evidence after
 * many dismissible ones, so every matched location becomes a flag that needs its own decision.
 */
export function scanSource(s: EvidenceSource, p: QuotaPatterns): Match[] {
  if (s.kind === 'events') return scanEvents(s.text, p);
  if (s.kind === 'termination') return scanText(s.text, p, s.field ?? 'field').map((m) => (s.text.includes('\n') ? m : { ...m, locator: s.field ?? 'field' }));
  return scanText(s.text, p);
}

export type DecisionStatus = 'pending' | 'reclassified' | 'dismissed';

export interface Decision {
  status: DecisionStatus;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface AuditFlag {
  id: string;
  slot: number;
  attempt: number;
  conditionId: string;
  kind: SourceKind;
  file: string;
  locator: string;
  rules: string[];
  excerpt: string;
  decision: Decision;
}

export interface ScannedAttempt {
  slot: number;
  attempt: number;
  conditionId: string;
  termination: string | null;
  sources: number;
  flags: number;
  /**
   * Legacy: matches an earlier, capped scanner discarded. The current scanner never writes it. An
   * audit that records any discarded match is incomplete, because the discarded evidence has no decision.
   */
  truncatedMatches?: number;
}

export interface BlockAudit {
  schema: typeof AUDIT_SCHEMA;
  label: string;
  block: number;
  patterns: { file: string; sha256: string };
  generatedAt: string;
  scope: AuditScope;
  scanned: ScannedAttempt[];
  flags: AuditFlag[];
  status: 'complete' | 'incomplete';
  pendingFlags: number;
  reclassified: Array<{ slot: number; attempt: number; flagIds: string[] }>;
}

/** The audit scope: finished attempts whose recorded outcome is a scored failure. */
export const isAuditable = (rec: Pick<AttemptRecord, 'phase' | 'outcome'>): boolean => rec.phase === 'finished' && rec.outcome === 'scored-failure';

const pad = (n: number) => String(n).padStart(2, '0');

/** Stable flag id: the same evidence always yields the same id, so decisions survive a rescan. */
export function flagId(block: number, slot: number, attempt: number, file: string, m: Match): string {
  const h = createHash('sha256').update([file, m.locator, m.rules.join(','), m.excerpt].join('\u0000')).digest('hex').slice(0, 10);
  return `b${pad(block)}-s${pad(slot)}-a${attempt}-${h}`;
}

const PENDING: Decision = { status: 'pending', reason: null, decidedBy: null, decidedAt: null };

export interface AttemptIdentity {
  block: number;
  slot: number;
  attempt: number;
  conditionId: string;
}

/** Flags for one attempt. Uses only the attempt's identity and its own evidence. */
export function auditAttempt(id: AttemptIdentity, sources: EvidenceSource[], p: QuotaPatterns): { flags: AuditFlag[] } {
  const flags: AuditFlag[] = [];
  const ids = new Set<string>();
  for (const s of sources) {
    for (const m of scanSource(s, p)) {
      const fid = flagId(id.block, id.slot, id.attempt, s.file, m);
      if (ids.has(fid)) continue;
      ids.add(fid);
      flags.push({ id: fid, slot: id.slot, attempt: id.attempt, conditionId: id.conditionId, kind: s.kind, file: s.file, locator: m.locator, rules: m.rules, excerpt: m.excerpt, decision: { ...PENDING } });
    }
  }
  return { flags };
}

export interface AuditInput {
  label: string;
  block: number;
  patterns: { file: string; sha256: string };
  generatedAt: string;
  attempts: Array<{ rec: AttemptRecord; sources: EvidenceSource[] }>;
  /**
   * `scored-failure` (default, the methodology's scope) or `all-finished`, a pilot-only diagnostic of
   * how noisy the patterns are on ordinary records. The CLI never writes an `all-finished` audit.
   */
  scope?: AuditScope;
}

export type AuditScope = 'scored-failure' | 'all-finished';

/**
 * Build (or rebuild) a block audit. Decisions from `previous` carry over by flag id. Records and the
 * pattern list are frozen, so a previous flag that no longer appears, or a changed pattern file,
 * means the evidence changed under a decision: refuse rather than drop it.
 */
export function buildAudit(i: AuditInput, p: QuotaPatterns, previous: BlockAudit | null): BlockAudit {
  if (previous) {
    if (previous.label !== i.label || previous.block !== i.block) throw new Error(`previous audit is for ${previous.label} block ${previous.block}, not ${i.label} block ${i.block}`);
    if (previous.scope !== (i.scope ?? 'scored-failure')) throw new Error(`previous audit has scope ${previous.scope}`);
    if (previous.patterns.sha256 !== i.patterns.sha256) throw new Error(`pattern list changed since the previous audit (${previous.patterns.sha256} → ${i.patterns.sha256}); the list is fixed at the freeze`);
  }
  const scanned: ScannedAttempt[] = [];
  const flags: AuditFlag[] = [];
  const scope = i.scope ?? 'scored-failure';
  const inScope = scope === 'all-finished' ? (r: AttemptRecord) => r.phase === 'finished' : isAuditable;
  const sorted = [...i.attempts].filter((a) => inScope(a.rec)).sort((a, b) => a.rec.slot - b.rec.slot || a.rec.attempt - b.rec.attempt);
  for (const { rec, sources } of sorted) {
    if (rec.block !== i.block) throw new Error(`attempt slot ${rec.slot} attempt ${rec.attempt} is in block ${rec.block}, not ${i.block}`);
    const r = auditAttempt(rec, sources, p);
    scanned.push({ slot: rec.slot, attempt: rec.attempt, conditionId: rec.conditionId, termination: rec.termination, sources: sources.length, flags: r.flags.length });
    flags.push(...r.flags);
  }
  if (previous) {
    const now = new Map(flags.map((f) => [f.id, f]));
    const vanished = previous.flags.filter((f) => !now.has(f.id));
    if (vanished.length) throw new Error(`records changed since the previous audit: ${vanished.length} flag(s) no longer match (${vanished.map((f) => f.id).join(', ')})`);
    for (const f of previous.flags) now.get(f.id)!.decision = { ...f.decision };
  }
  return finalise({ schema: AUDIT_SCHEMA, label: i.label, block: i.block, patterns: i.patterns, generatedAt: i.generatedAt, scope, scanned, flags, status: 'incomplete', pendingFlags: 0, reclassified: [] });
}

/** Matches a legacy capped scan discarded: evidence without a flag, so without a decision. */
export const discardedMatches = (a: Pick<BlockAudit, 'scanned'>): number => a.scanned.reduce((n, s) => n + (typeof s.truncatedMatches === 'number' && s.truncatedMatches > 0 ? s.truncatedMatches : 0), 0);

/** Recompute the derived fields from the flags. Discarded matches (legacy audits) keep it incomplete. */
export function finalise(a: BlockAudit): BlockAudit {
  const pendingFlags = a.flags.filter((f) => f.decision.status === 'pending').length;
  const by = new Map<string, { slot: number; attempt: number; flagIds: string[] }>();
  for (const f of a.flags) {
    if (f.decision.status !== 'reclassified') continue;
    const k = `${f.slot}/${f.attempt}`;
    const e = by.get(k) ?? { slot: f.slot, attempt: f.attempt, flagIds: [] };
    e.flagIds.push(f.id);
    by.set(k, e);
  }
  const reclassified = [...by.values()].sort((x, y) => x.slot - y.slot || x.attempt - y.attempt);
  return { ...a, pendingFlags, status: pendingFlags === 0 && discardedMatches(a) === 0 ? 'complete' : 'incomplete', reclassified };
}

export interface DecisionInput {
  flagId: string;
  status: Exclude<DecisionStatus, 'pending'>;
  reason: string;
  decidedBy: string;
  decidedAt: string;
}

/** Record one decision. A decision needs a reason and a person, and an existing decision is never overwritten. */
export function recordDecision(a: BlockAudit, d: DecisionInput): BlockAudit {
  if (d.status !== 'reclassified' && d.status !== 'dismissed') throw new Error(`decision must be reclassified or dismissed, not ${String(d.status)}`);
  if (!d.reason.trim()) throw new Error('a decision needs a reason');
  if (!d.decidedBy.trim()) throw new Error('a decision needs the name of the person deciding');
  if (!/^\d{4}-\d{2}-\d{2}/.test(d.decidedAt)) throw new Error('decidedAt must be an ISO date');
  const f = a.flags.find((x) => x.id === d.flagId);
  if (!f) throw new Error(`no flag ${d.flagId} in ${a.label} block ${a.block}`);
  if (f.decision.status !== 'pending') throw new Error(`flag ${d.flagId} is already ${f.decision.status}; decisions are never overwritten`);
  const flags = a.flags.map((x) => (x.id === d.flagId ? { ...x, decision: { status: d.status, reason: d.reason.trim(), decidedBy: d.decidedBy.trim(), decidedAt: d.decidedAt } } : x));
  return finalise({ ...a, flags });
}

export interface Reclassification {
  auditFile: string;
  flagIds: string[];
  originalTermination: string | null;
  originalTerminationDetail: string | null;
  originalOutcome: string | null;
  originalAccepted: boolean | null;
}

export type AuditedRecord = AttemptRecord & { reclassification?: Reclassification };

/**
 * The attempt as the campaign and the analysis must treat it. A reclassified attempt becomes
 * operational `quota-exhausted` with its usage, stages and evaluation untouched, and links the
 * flags that justified it. Any other attempt is returned unchanged.
 */
export function applyAudit(rec: AttemptRecord, audit: BlockAudit | null, auditFile: string): AuditedRecord {
  if (!audit || audit.label !== rec.campaign || audit.block !== rec.block || !isAuditable(rec)) return rec;
  const hit = audit.flags.filter((f) => f.slot === rec.slot && f.attempt === rec.attempt && f.decision.status === 'reclassified');
  if (hit.length === 0) return rec;
  return {
    ...rec,
    termination: 'quota-exhausted',
    terminationDetail: `reclassified by quota audit (${hit.map((f) => f.id).join(', ')})`,
    outcome: 'operational',
    accepted: null,
    reclassification: {
      auditFile,
      flagIds: hit.map((f) => f.id),
      originalTermination: rec.termination,
      originalTerminationDetail: rec.terminationDetail,
      originalOutcome: rec.outcome,
      originalAccepted: rec.accepted,
    },
  };
}

export interface BlockAuditStatus {
  block: number;
  status: 'complete' | 'incomplete' | 'missing';
  pendingFlags: number;
  /** Scored-failure attempts present in the records but absent from the audit (for example a later refill). */
  unscanned: Array<{ slot: number; attempt: number }>;
  /** True when the audit was made with a pattern list other than the current one. */
  stalePatterns: boolean;
  /** Matches a legacy capped scan discarded without a flag or decision; any makes the block incomplete. */
  discardedMatches: number;
}

/**
 * Whether a block's audit covers its current records. `recs` are the raw attempt records of the
 * block. With `currentPatternsSha`, an audit made with another pattern list is incomplete too.
 */
export function auditCoverage(block: number, audit: BlockAudit | null, recs: AttemptRecord[], currentPatternsSha?: string): BlockAuditStatus {
  const due = recs.filter((r) => r.block === block && isAuditable(r));
  if (!audit) return { block, status: 'missing', pendingFlags: 0, unscanned: due.map((r) => ({ slot: r.slot, attempt: r.attempt })), stalePatterns: false, discardedMatches: 0 };
  const scanned = new Set(audit.scanned.map((s) => `${s.slot}/${s.attempt}`));
  const unscanned = due.filter((r) => !scanned.has(`${r.slot}/${r.attempt}`)).map((r) => ({ slot: r.slot, attempt: r.attempt }));
  const pendingFlags = audit.flags.filter((f) => f.decision.status === 'pending').length;
  const stalePatterns = currentPatternsSha !== undefined && audit.patterns.sha256 !== currentPatternsSha;
  const discarded = discardedMatches(audit);
  return { block, status: pendingFlags === 0 && unscanned.length === 0 && !stalePatterns && discarded === 0 ? 'complete' : 'incomplete', pendingFlags, unscanned, stalePatterns, discardedMatches: discarded };
}
