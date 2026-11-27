/**
 * Quota-misclassification audit (methodology section 8). Every record here is SYNTHETIC: built in
 * memory, never read from records/.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountAttempt } from '../../src/accounting/record.ts';
import { aggregate, AnalysisValidationError, type AnalysisOptions } from '../../src/analysis/aggregate.ts';
import { classifyClaudeFailure, parseClaudeEvents } from '../../src/adapters/claude.ts';
import { classifyCodexFailure } from '../../src/adapters/codex.ts';
import {
  applyAudit,
  auditAttempt,
  auditCoverage,
  buildAudit,
  eventTreatment,
  finalise,
  parseQuotaPatterns,
  RATE_LIMIT_STATUS_RULE,
  recordDecision,
  scanText,
  type BlockAudit,
  type EvidenceSource,
} from '../../src/audit/quota.ts';
import { SCORED_FAILURES, type AttemptRecord } from '../../src/orchestrator/state.ts';
import { fullCampaign, MATRIX, MODELS, PROV, ROLES, ROOT, SCHEDULE, SETTLED, SNAP, synthRaw } from './support/synthetic-records.ts';

const RAW = JSON.parse(readFileSync(join(ROOT, 'config', 'quota-audit.json'), 'utf8'));
const P = parseQuotaPatterns(RAW);
const REF = { file: 'config/quota-audit.json', sha256: 'synthetic-pattern-hash' };
const at = '2026-11-21T00:00:00.000Z';

const scoredFailure = (o: { slot: number; attempt?: number; conditionId?: string; termination?: string; replaces?: number | null; block?: number }): AttemptRecord =>
  synthRaw({ block: o.block ?? 1, slot: o.slot, attempt: o.attempt ?? 1, conditionId: o.conditionId ?? SCHEDULE.blocks[0]!.slots[o.slot - 1]!.conditionId, termination: o.termination ?? 'model-error-exit', replaces: o.replaces ?? null }).attempt;

const stderr = (text: string, file = 'records/cohort-03/block-01/slot-01/attempt-1/stages/s1-implement/stderr.txt'): EvidenceSource => ({ kind: 'stderr', file, text });
const anyMatch = (line: string) => P.patterns.some((p) => p.regex.test(line));

describe('pattern list', () => {
  it('parses the committed config/quota-audit.json and carries both adapters’ quota patterns verbatim', () => {
    const codexSrc = readFileSync(join(ROOT, 'src', 'adapters', 'codex.ts'), 'utf8');
    const claudeSrc = readFileSync(join(ROOT, 'src', 'adapters', 'claude.ts'), 'utf8');
    const byId = Object.fromEntries(RAW.patterns.map((p: { id: string; regex: string }) => [p.id, p.regex]));
    expect(codexSrc).toContain(`['quota-exhausted', /${byId['codex-adapter-quota']}/i]`);
    expect(claudeSrc).toContain(`['quota-exhausted', /${byId['claude-adapter-quota']}/i]`);
  });

  it('flags every phrase the adapters classify as quota exhaustion, and the broader additions', () => {
    const adapterQuota = ["You've hit your usage limit. Try again in 3 hours.", 'usage_limit_reached', 'HTTP 429 Too Many Requests', 'rate-limited', 'Claude AI usage limit reached|1795543200', 'Your limit resets at 5pm', 'billing issue'];
    for (const t of adapterQuota) {
      expect(classifyCodexFailure([t]) === 'quota-exhausted' || classifyClaudeFailure([t]) === 'quota-exhausted').toBe(true);
      expect(scanText(t, P)).toHaveLength(1);
    }
    for (const t of ['API Error: 529 {"type":"overloaded_error"}', 'Your credit balance is too low', 'You have reached your plan limit', 'limit will reset after the window', 'exceeded your monthly allowance']) {
      expect(scanText(t, P), t).toHaveLength(1);
    }
  });

  it('does not flag ordinary build output', () => {
    for (const t of ['reset progress to zero, clear result/error, and update `updatedAt`', 'npm run build', 'POST /jobs 201 in 12ms', 'retrying job 7 (attempt 2 of 3)']) expect(scanText(t, P), t).toEqual([]);
  });

  it('rejects malformed pattern lists rather than auditing with a broken one', () => {
    expect(() => parseQuotaPatterns({ ...RAW, schema: 'x' })).toThrow(/schema/);
    expect(() => parseQuotaPatterns({ ...RAW, patterns: [] })).toThrow(/non-empty/);
    expect(() => parseQuotaPatterns({ ...RAW, patterns: [{ id: 'a', regex: 'x*' }] })).toThrow(/empty string/);
    expect(() => parseQuotaPatterns({ ...RAW, patterns: [{ id: 'a', regex: 'x' }, { id: 'a', regex: 'y' }] })).toThrow(/duplicate/);
    expect(() => parseQuotaPatterns({ ...RAW, patterns: [{ id: RATE_LIMIT_STATUS_RULE, regex: 'y' }] })).toThrow(/reserved/);
    expect(() => parseQuotaPatterns({ ...RAW, patterns: [{ id: 'a', regex: '(' }] })).toThrow();
    expect(() => parseQuotaPatterns({ ...RAW, excerptChars: 0 })).toThrow(/excerptChars/);
    expect(() => parseQuotaPatterns({ ...RAW, consoleFlagsPerAttempt: 0 })).toThrow(/consoleFlagsPerAttempt/);
    // The old capping field must not run silently under a scanner that keeps every flag.
    expect(() => parseQuotaPatterns({ ...RAW, maxFlagsPerSource: 20 })).toThrow(/maxFlagsPerSource is no longer supported/);
  });
});

describe('event streams', () => {
  it('skips routine allowed rate-limit telemetry but flags any other status', () => {
    const info = { status: 'allowed', resetsAt: 1795543200, rateLimitType: 'seven_day', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' };
    expect(eventTreatment({ type: 'rate_limit_event', rate_limit_info: info })).toEqual({ kind: 'skip' });
    expect(eventTreatment({ type: 'rate_limit_event', rate_limit_info: { ...info, status: 'rejected' } })).toMatchObject({ kind: 'flag', rule: RATE_LIMIT_STATUS_RULE });
    expect(eventTreatment({ type: 'rate_limit_event' })).toMatchObject({ kind: 'flag' });
  });

  it('skips model- and tool-authored content and scans client events', () => {
    expect(eventTreatment({ type: 'assistant', message: { content: 'quota' } }).kind).toBe('skip');
    expect(eventTreatment({ type: 'user', message: { content: 'HTTP 429' } }).kind).toBe('skip');
    expect(eventTreatment({ type: 'system', subtype: 'init' }).kind).toBe('skip');
    expect(eventTreatment({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: '429 Too Many Requests' } }).kind).toBe('skip');
    expect(eventTreatment({ type: 'item.completed', item: { type: 'error', message: 'usage limit' } }).kind).toBe('scan');
    expect(eventTreatment({ type: 'some.new.event', note: 'x' }).kind).toBe('scan');
  });

  it('finds quota evidence in client errors, retries and failed results', () => {
    const lines = [
      { type: 'error', message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours." },
      { type: 'turn.failed', error: { message: 'stream error: 429 Too Many Requests' } },
      { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 529, error: 'overloaded' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: '' },
    ].map((e) => JSON.stringify(e));
    const flags = auditAttempt({ block: 1, slot: 1, attempt: 1, conditionId: 'solo.CF.off' }, [{ kind: 'events', file: 'e.jsonl', text: lines.join('\n') }], P).flags;
    expect(flags.map((f) => f.locator.split(' ').slice(0, 2).join(' '))).toEqual(['line 1', 'line 2', 'line 3', 'line 3', 'line 4']);
    expect(flags.find((f) => f.locator === 'line 3 $.error_status')?.rules).toEqual(['http-429-529']);
  });

  it('scans Claude client-generated assistant error messages but still skips ordinary assistant content', () => {
    expect(eventTreatment({ type: 'assistant', error: 'billing_error', message: { model: 'claude-x', content: 'Your credit balance is too low' } }).kind).toBe('scan');
    expect(eventTreatment({ type: 'assistant', is_api_error_message: true, message: { content: 'x' } }).kind).toBe('scan');
    expect(eventTreatment({ type: 'assistant', message: { model: '<synthetic>', content: 'x' } }).kind).toBe('scan');
    expect(eventTreatment({ type: 'assistant', is_api_error_message: false, message: { model: 'claude-x', content: 'quota' } }).kind).toBe('skip');
  });

  it('regression: quota evidence confined to a client-generated assistant error raises a pending flag', () => {
    // The shape parseClaudeEvents records as an API error; no final message, model-error-exit, clean stderr.
    const ev = {
      type: 'assistant',
      error: 'billing_error',
      is_api_error_message: true,
      api_error_status: 400,
      parent_tool_use_id: null,
      message: { id: 'msg_synthetic', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Your credit balance is too low to access the Anthropic API.' }] },
    };
    const events = [JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x' }), JSON.stringify(ev), JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: '' })].join('\n');
    const parsed = parseClaudeEvents(events);
    expect(parsed.apiErrors).toHaveLength(1);
    expect(parsed.finalMessage).toBeNull();
    const rec = scoredFailure({ slot: 1, termination: 'model-error-exit' });
    const file = 'records/cohort-03/block-01/slot-01/attempt-1/stages/s1-implement/events.jsonl';
    const a = buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: [{ rec, sources: [stderr(''), { kind: 'events', file, text: events }] }] }, P, null);
    // Every flag comes from the error event (line 2): its `billing_error` kind and its message text.
    expect(a.flags.map((f) => f.locator).sort()).toEqual(['line 2 $.error', 'line 2 $.message.content[0].text']);
    for (const f of a.flags) expect(f).toMatchObject({ slot: 1, kind: 'events', file, decision: { status: 'pending' } });
    expect(a.flags.find((f) => f.locator.endsWith('.text'))!.excerpt).toContain('credit balance is too low');
    expect(a).toMatchObject({ status: 'incomplete', pendingFlags: 2 });
  });

  it('does not flag keys or token counts in an ordinary result event', () => {
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'Done.', usage: { input_tokens: 429, output_tokens: 529, fallback_credit: null, service_tier: 'standard' }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 429 } } };
    expect(auditAttempt({ block: 1, slot: 1, attempt: 1, conditionId: 'solo.AC.off' }, [{ kind: 'events', file: 'e.jsonl', text: JSON.stringify(result) }], P).flags).toEqual([]);
  });

  it('scans lines that are not JSON as text', () => {
    expect(auditAttempt({ block: 1, slot: 1, attempt: 1, conditionId: 'solo.AC.off' }, [{ kind: 'events', file: 'e.jsonl', text: 'not json: rate limit exceeded' }], P).flags).toHaveLength(1);
  });
});

describe('excerpts', () => {
  it('scrubs credentials and keeps one bounded line', () => {
    const line = `${'x'.repeat(300)} Authorization: Bearer abcdefghijklmnop 429 Too Many Requests sk-ant-abcdefghijklmnopqrstuvwx ${'y'.repeat(300)}`;
    const [m] = scanText(line, P);
    expect(m!.excerpt).not.toContain('abcdefghijklmnop ');
    expect(m!.excerpt).not.toContain('sk-ant-');
    expect(m!.excerpt).toContain('429');
    expect(m!.excerpt.length).toBeLessThanOrEqual(P.excerptChars + 2);
  });
});

describe('buildAudit and decisions', () => {
  const quotaText = 'ERROR: You have hit your usage limit. Your limit resets at 14:00.';
  const recs = [scoredFailure({ slot: 1 }), scoredFailure({ slot: 2, termination: 'stage-timeout' }), synthRaw({ block: 1, slot: 3, conditionId: SCHEDULE.blocks[0]!.slots[2]!.conditionId, termination: 'completed' }).attempt];
  const sources = (rec: AttemptRecord) => (rec.slot === 1 ? [stderr(quotaText)] : rec.slot === 3 ? [stderr(quotaText)] : [stderr('build failed: TS2304')]);
  const fresh = () => buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: recs.map((rec) => ({ rec, sources: sources(rec) })) }, P, null);

  it('scans scored failures only, and every new flag is pending, so the block is incomplete', () => {
    const a = fresh();
    expect(a.scanned.map((s) => s.slot)).toEqual([1, 2]);
    expect(a.flags).toHaveLength(1);
    expect(a.flags[0]).toMatchObject({ slot: 1, attempt: 1, kind: 'stderr', locator: 'line 1', decision: { status: 'pending', reason: null } });
    expect(a).toMatchObject({ status: 'incomplete', pendingFlags: 1, reclassified: [] });
  });

  it('records a decision with its reason and person, never overwrites it, and completes the block', () => {
    const a = fresh();
    const id = a.flags[0]!.id;
    expect(() => recordDecision(a, { flagId: id, status: 'reclassified', reason: ' ', decidedBy: 'G', decidedAt: at })).toThrow(/reason/);
    expect(() => recordDecision(a, { flagId: id, status: 'reclassified', reason: 'r', decidedBy: '', decidedAt: at })).toThrow(/person/);
    expect(() => recordDecision(a, { flagId: 'nope', status: 'dismissed', reason: 'r', decidedBy: 'G', decidedAt: at })).toThrow(/no flag/);
    expect(() => recordDecision(a, { flagId: id, status: 'pending' as never, reason: 'r', decidedBy: 'G', decidedAt: at })).toThrow();
    const d = recordDecision(a, { flagId: id, status: 'reclassified', reason: 'client usage-limit message in stderr', decidedBy: 'Glenn', decidedAt: at });
    expect(d).toMatchObject({ status: 'complete', pendingFlags: 0, reclassified: [{ slot: 1, attempt: 1, flagIds: [id] }] });
    expect(() => recordDecision(d, { flagId: id, status: 'dismissed', reason: 'r', decidedBy: 'G', decidedAt: at })).toThrow(/never overwritten/);
  });

  it('keeps decisions across a rescan and refuses when evidence or patterns changed under them', () => {
    const d = recordDecision(fresh(), { flagId: fresh().flags[0]!.id, status: 'dismissed', reason: 'quoted in a test fixture', decidedBy: 'Glenn', decidedAt: at });
    const again = buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: recs.map((rec) => ({ rec, sources: sources(rec) })) }, P, d);
    expect(again.flags[0]!.decision).toEqual(d.flags[0]!.decision);
    expect(again.status).toBe('complete');
    expect(() => buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: recs.map((rec) => ({ rec, sources: [stderr('clean')] })) }, P, d)).toThrow(/records changed/);
    expect(() => buildAudit({ label: 'cohort-03', block: 1, patterns: { ...REF, sha256: 'other' }, generatedAt: at, attempts: [] }, P, d)).toThrow(/pattern list changed/);
    expect(() => buildAudit({ label: 'cohort-03', block: 2, patterns: REF, generatedAt: at, attempts: [] }, P, d)).toThrow(/block 1/);
  });

  it('coverage: missing audit, unscanned refill, and pending flags all leave the block incomplete', () => {
    const a = fresh();
    expect(auditCoverage(1, null, recs)).toMatchObject({ status: 'missing', unscanned: [{ slot: 1, attempt: 1 }, { slot: 2, attempt: 1 }] });
    expect(auditCoverage(1, a, recs)).toMatchObject({ status: 'incomplete', pendingFlags: 1, unscanned: [] });
    const done = recordDecision(a, { flagId: a.flags[0]!.id, status: 'reclassified', reason: 'r', decidedBy: 'G', decidedAt: at });
    expect(auditCoverage(1, done, recs).status).toBe('complete');
    const refill = scoredFailure({ slot: 1, attempt: 2, replaces: 1 });
    expect(auditCoverage(1, done, [...recs, refill])).toMatchObject({ status: 'incomplete', unscanned: [{ slot: 1, attempt: 2 }] });
    expect(auditCoverage(1, done, recs, REF.sha256).status).toBe('complete');
    expect(auditCoverage(1, done, recs, 'edited-pattern-file')).toMatchObject({ status: 'incomplete', stalePatterns: true });
  });
});

describe('no cap on flags', () => {
  const rec = scoredFailure({ slot: 1 });
  const credit = (n: number) => Array.from({ length: n }, (_, i) => `test fixture ${i}: credit card field rejected`);
  const quota = 'ERROR: You have hit your usage limit. Try again in 3 hours.';
  const build = (lines: string[]) => buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: [{ rec, sources: [stderr(lines.join('\n'))] }] }, P, null);
  const dismissWhere = (a: BlockAudit, pick: (f: BlockAudit['flags'][number]) => boolean) =>
    a.flags.filter(pick).reduce((acc, f) => recordDecision(acc, { flagId: f.id, status: 'dismissed', reason: 'fixture text', decidedBy: 'G', decidedAt: at }), a);

  it('regression: usage-limit evidence after 20 dismissible credit lines is kept and stays pending', () => {
    const a = build([...credit(20), quota]);
    expect(a.flags).toHaveLength(21);
    expect(a.scanned[0]).toMatchObject({ flags: 21 });
    expect(a.scanned[0]!.truncatedMatches).toBeUndefined();
    const late = a.flags.find((f) => f.locator === 'line 21')!;
    expect(late.excerpt).toContain('usage limit');
    const d = dismissWhere(a, (f) => f.rules.join() === 'credit');
    expect(d).toMatchObject({ status: 'incomplete', pendingFlags: 1 });
    expect(d.flags.filter((f) => f.decision.status === 'pending').map((f) => f.id)).toEqual([late.id]);
    expect(auditCoverage(1, d, [rec], REF.sha256)).toMatchObject({ status: 'incomplete', pendingFlags: 1 });
    const done = recordDecision(d, { flagId: late.id, status: 'reclassified', reason: 'usage limit', decidedBy: 'G', decidedAt: at });
    expect(auditCoverage(1, done, [rec], REF.sha256).status).toBe('complete');
    expect(applyAudit(rec, done, 'f')).toMatchObject({ termination: 'quota-exhausted', outcome: 'operational' });
  });

  it('a legacy audit that discarded matches is incomplete even with every listed flag decided', () => {
    const a = dismissWhere(build(credit(3)), () => true);
    expect(a.status).toBe('complete');
    const legacy = { ...a, scanned: a.scanned.map((x) => ({ ...x, truncatedMatches: 5 })) };
    expect(finalise(legacy)).toMatchObject({ status: 'incomplete', pendingFlags: 0 });
    expect(auditCoverage(1, legacy, [rec], REF.sha256)).toMatchObject({ status: 'incomplete', discardedMatches: 5 });
    expect(auditCoverage(1, { ...a, scanned: a.scanned.map((x) => ({ ...x, truncatedMatches: 0 })) }, [rec], REF.sha256).status).toBe('complete');
  });

  it('property: any number of earlier dismissed matches never hides later quota evidence', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 120 }), fc.integer({ min: 1, max: 5 }), (early, late) => {
        const a = build([...credit(early), ...Array.from({ length: late }, () => quota)]);
        expect(a.flags).toHaveLength(early + late);
        const d = dismissWhere(a, (f) => Number(/^line (\d+)$/.exec(f.locator)![1]) <= early);
        expect(d.pendingFlags).toBe(late);
        expect(d.status).toBe('incomplete');
        expect(auditCoverage(1, d, [rec], REF.sha256).status).toBe('incomplete');
        for (const f of d.flags.filter((x) => x.decision.status === 'pending')) expect(f.excerpt).toContain('usage limit');
      }),
      { numRuns: 60 },
    );
  });
});

describe('applyAudit', () => {
  const rec = scoredFailure({ slot: 4, termination: 'task-timeout' });
  const audit = (status: 'reclassified' | 'dismissed' | 'pending'): BlockAudit => {
    const a = buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: [{ rec, sources: [stderr('429 Too Many Requests')] }] }, P, null);
    return status === 'pending' ? a : recordDecision(a, { flagId: a.flags[0]!.id, status, reason: 'r', decidedBy: 'G', decidedAt: at });
  };

  it('reclassifies to operational quota-exhausted, keeps usage and evaluation, and links the evidence', () => {
    const a = audit('reclassified');
    const out = applyAudit(rec, a, 'records/cohort-03/block-01/audit.json');
    expect(out).toMatchObject({ termination: 'quota-exhausted', outcome: 'operational', accepted: null, phase: 'finished', reclassification: { auditFile: 'records/cohort-03/block-01/audit.json', flagIds: [a.flags[0]!.id], originalTermination: 'task-timeout', originalOutcome: 'scored-failure', originalAccepted: false } });
    expect(out.stages).toEqual(rec.stages);
    expect(out.evaluation).toEqual(rec.evaluation);
    const acc = accountAttempt({ attempt: out, stageRecords: synthRaw({ block: 1, slot: 4, conditionId: rec.conditionId }).records, roles: ROLES, snapshot: SNAP, semantics: SETTLED, provenance: PROV });
    expect(acc).toMatchObject({ scored: false, termination: 'quota-exhausted', reclassification: { originalTermination: 'task-timeout', originalOutcome: 'scored-failure', originalAccepted: false, originalTerminationDetail: null } });
    expect(acc.totals.cost.status).toBe('exact');
  });

  it('leaves the record unchanged for dismissed or pending flags, another cohort, or another block', () => {
    expect(applyAudit(rec, audit('dismissed'), 'f')).toBe(rec);
    expect(applyAudit(rec, audit('pending'), 'f')).toBe(rec);
    expect(applyAudit(rec, null, 'f')).toBe(rec);
    expect(applyAudit({ ...rec, campaign: 'cohort-04' }, audit('reclassified'), 'f').termination).toBe('task-timeout');
    expect(applyAudit({ ...rec, block: 2 }, audit('reclassified'), 'f').termination).toBe('task-timeout');
  });
});

describe('aggregation reads audit decisions', () => {
  const OPTS: AnalysisOptions = { label: 'cohort-03', dataset: 'synthetic', matrix: MATRIX, schedule: SCHEDULE, roles: MODELS.roles, bootstrap: { seed: 1, resamples: 50, confidence: 0.95 } };
  const account = (rec: AttemptRecord) => accountAttempt({ attempt: rec, stageRecords: synthRaw({ block: rec.block, slot: rec.slot, conditionId: rec.conditionId }).records, roles: ROLES, snapshot: SNAP, semantics: SETTLED, provenance: PROV });

  it('a reclassified attempt leaves the denominator, and its refill is the scored workflow', () => {
    const s1 = SCHEDULE.blocks[0]!.slots[0]!;
    const failed = scoredFailure({ slot: s1.slot, conditionId: s1.conditionId, termination: 'model-error-exit' });
    const a = buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: [{ rec: failed, sources: [stderr('usage limit reached')] }] }, P, null);
    const decided = recordDecision(a, { flagId: a.flags[0]!.id, status: 'reclassified', reason: 'r', decidedBy: 'G', decidedAt: at });
    const refill = synthRaw({ block: 1, slot: s1.slot, conditionId: s1.conditionId, attempt: 2, replaces: 1, termination: 'completed' }).attempt;
    const others = fullCampaign(() => ({}), 1).filter((r) => r.slot !== s1.slot);
    // Without the overlay, a replacement of a scored attempt is refused.
    expect(() => aggregate([...others, account(failed), account(refill)], OPTS)).toThrow(AnalysisValidationError);
    const out = aggregate([...others, account(applyAudit(failed, decided, 'f')), account(applyAudit(refill, decided, 'f'))], { ...OPTS, audits: [auditCoverage(1, decided, [failed, refill])] });
    expect(out.operational.byTermination).toEqual({ 'quota-exhausted': 1 });
    expect(out.operational.exclusions[0]).toMatchObject({ slot: s1.slot, attempt: 1, replacedBy: 2 });
    // The refill completed, so it is not a scored failure and needs no scan: the block audit is complete.
    expect(out.completeness.audit).toMatchObject({ complete: true, blocks: [{ block: 1, status: 'complete', unscanned: [] }] });
  });

  it('an incomplete block audit keeps an otherwise complete cohort incomplete', () => {
    const recs = fullCampaign();
    expect(aggregate(recs, OPTS).completeness.complete).toBe(true);
    const audits = SCHEDULE.blocks.map((_, i) => ({ block: i + 1, status: 'complete' as const, pendingFlags: 0, unscanned: [], stalePatterns: false, discardedMatches: 0 }));
    expect(aggregate(recs, { ...OPTS, audits }).completeness.complete).toBe(true);
    audits[3] = { block: 4, status: 'incomplete' as never, pendingFlags: 1, unscanned: [], stalePatterns: false, discardedMatches: 0 };
    expect(aggregate(recs, { ...OPTS, audits }).completeness).toMatchObject({ complete: false, audit: { complete: false } });
  });
});

describe('properties', () => {
  const line = fc.oneof(fc.string({ maxLength: 80 }), fc.constantFrom('429 Too Many Requests', 'usage limit reached', 'resets at 3pm', 'overloaded', 'credit balance low', 'build ok', 'reset progress'));
  const text = fc.array(line, { maxLength: 8 }).map((ls) => ls.join('\n'));

  it('no flag without matched evidence: every flag points at a line its rules match, and a text no rule matches yields none', () => {
    fc.assert(
      fc.property(text, (t) => {
        const { flags } = auditAttempt({ block: 1, slot: 1, attempt: 1, conditionId: 'solo.CF.off' }, [stderr(t)], P);
        const lines = t.split('\n');
        for (const f of flags) {
          const n = Number(/^line (\d+)$/.exec(f.locator)![1]);
          expect(f.rules.length).toBeGreaterThan(0);
          for (const r of f.rules) expect(P.patterns.find((p) => p.id === r)!.regex.test(lines[n - 1]!)).toBe(true);
        }
        const matching = lines.filter(anyMatch).length;
        expect(flags.length).toBe(matching);
      }),
    );
  });

  it('flags never depend on outcome or condition, and a scan never decides', () => {
    const terminations = [...SCORED_FAILURES];
    const conditions = MATRIX.canonicalConditionOrder;
    fc.assert(
      fc.property(text, fc.constantFrom(...terminations), fc.constantFrom(...terminations), fc.constantFrom(...conditions), fc.constantFrom(...conditions), fc.boolean(), (t, ta, tb, ca, cb, evaluated) => {
        const mk = (termination: string, conditionId: string): AttemptRecord => {
          const r = scoredFailure({ slot: 5, conditionId, termination });
          return evaluated ? r : { ...r, evaluation: { status: 'not-run', verdictFile: null, durationMs: null, snapshotHash: null, reason: 'x' } };
        };
        const run = (rec: AttemptRecord) => buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: [{ rec, sources: [stderr(t)] }] }, P, null);
        const a = run(mk(ta, ca));
        const b = run(mk(tb, cb));
        const strip = (x: BlockAudit) => x.flags.map(({ conditionId: _c, ...f }) => f);
        expect(strip(a)).toEqual(strip(b));
        expect(a.flags.every((f) => f.decision.status === 'pending')).toBe(true);
        expect(a.status).toBe(a.flags.length ? 'incomplete' : 'complete');
      }),
    );
  });

  it('aggregation excludes every reclassified attempt and nothing else', () => {
    const base = fullCampaign((s) => ({ termination: s.slot % 3 === 0 ? 'task-timeout' : 'completed' }), 1);
    const raws = SCHEDULE.blocks[0]!.slots.map((s) => synthRaw({ ...s, termination: s.slot % 3 === 0 ? 'task-timeout' : 'completed' }).attempt);
    const failures = raws.filter((r) => r.outcome === 'scored-failure');
    const OPTS: AnalysisOptions = { label: 'cohort-03', dataset: 'synthetic', matrix: MATRIX, schedule: SCHEDULE, roles: MODELS.roles, bootstrap: { seed: 1, resamples: 20, confidence: 0.95 } };
    fc.assert(
      fc.property(fc.subarray(failures.map((r) => r.slot)), (chosen) => {
        let a = buildAudit({ label: 'cohort-03', block: 1, patterns: REF, generatedAt: at, attempts: raws.map((rec) => ({ rec, sources: [stderr(chosen.includes(rec.slot) ? 'usage limit reached' : 'tests failed')] })) }, P, null);
        for (const f of a.flags) a = recordDecision(a, { flagId: f.id, status: 'reclassified', reason: 'r', decidedBy: 'G', decidedAt: at });
        const recs = raws.map((r) => accountAttempt({ attempt: applyAudit(r, a, 'f'), stageRecords: synthRaw({ block: 1, slot: r.slot, conditionId: r.conditionId }).records, roles: ROLES, snapshot: SNAP, semantics: SETTLED, provenance: PROV }));
        const out = aggregate(recs, OPTS);
        const scoredSlots = Object.values(out.workflows).flatMap((w) => w.conditions.flatMap((c) => c.workflows.map((r) => r.slot)));
        expect(scoredSlots.length).toBe(base.length - chosen.length);
        for (const s of chosen) expect(scoredSlots).not.toContain(s);
        expect(out.operational.attempts).toBe(chosen.length);
      }),
      { numRuns: 30 },
    );
  });
});
