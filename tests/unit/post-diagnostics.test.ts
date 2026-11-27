import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  classifyRejection,
  rejectionTable,
  checkRunTable,
  selectTraceKey,
  INFLIGHT_CASE,
  START_CASE,
  type DiagnosticRow,
} from '../../post/diagnostics.ts';

// SYNTHETIC rows only: invented verdict shapes, never observations.
const ok = (id: string) => ({ id, passed: true, detail: '' });
const bad = (id: string, detail = 'x') => ({ id, passed: false, detail });
const ATTEMPTS = 'attempts must count the interrupted attempt (observed 1)';

const row = (over: Partial<DiagnosticRow>): DiagnosticRow => ({
  conditionId: 'solo.AC.on',
  block: 1,
  slot: 1,
  scored: true,
  accepted: false,
  buildOk: true,
  cases: [ok(START_CASE), bad(INFLIGHT_CASE, ATTEMPTS)],
  checkRuns: [],
  ...over,
});

describe('classifyRejection', () => {
  it('returns accepted for an accepted workflow', () => {
    expect(classifyRejection(row({ accepted: true, cases: [ok(START_CASE)] }))).toBe('accepted');
  });
  it('isolates a rejection caused only by the in-flight attempt count', () => {
    expect(classifyRejection(row({}))).toBe('inflight-attempt-count-only');
  });
  it('does not treat another in-flight failure detail as the attempt-count rule', () => {
    expect(classifyRejection(row({ cases: [ok(START_CASE), bad(INFLIGHT_CASE, 'timed out')] }))).toBe('other');
  });
  it('reports a failed evaluator build before anything else', () => {
    expect(classifyRejection(row({ buildOk: false, cases: [bad(START_CASE), bad(INFLIGHT_CASE, ATTEMPTS)] }))).toBe('build-failed');
  });
  it('reports an app that built but never answered health', () => {
    expect(classifyRejection(row({ cases: [bad(START_CASE), bad(INFLIGHT_CASE)] }))).toBe('did-not-start');
  });
  it('reports any other combination as other', () => {
    expect(classifyRejection(row({ cases: [ok(START_CASE), bad(INFLIGHT_CASE, ATTEMPTS), bad('A8.live-updates')] }))).toBe('other');
  });
  it('treats a rejected workflow with no failed case as other rather than inventing a cause', () => {
    expect(classifyRejection(row({ cases: [ok(START_CASE)] }))).toBe('other');
  });
});

describe('rejectionTable', () => {
  it('counts per condition and ignores unscored attempts', () => {
    const t = rejectionTable([row({}), row({ accepted: true, cases: [ok(START_CASE)] }), row({ scored: false })]);
    expect(t).toEqual([{ conditionId: 'solo.AC.on', scored: 2, accepted: 1, 'build-failed': 0, 'did-not-start': 0, 'inflight-attempt-count-only': 1, other: 0 }]);
  });
});

describe('checkRunTable', () => {
  it('counts check runs and which suites failed', () => {
    const t = checkRunTable([
      row({ checkRuns: [{ status: 'failed', failedSuites: ['build'] }, { status: 'passed', failedSuites: [] }] }),
      row({ conditionId: 'solo.AC.off', checkRuns: [] }),
    ]);
    expect(t).toEqual({ workflowsWithChecks: 1, runs: 2, passedRuns: 1, failedRuns: 1, failedBySuite: { build: 1 }, finalPassedAccepted: 0, finalPassedRejected: 1, finalFailed: 0 });
  });
});

describe('selectTraceKey', () => {
  it('picks the first scored workflow in schedule order', () => {
    expect(selectTraceKey([row({ block: 2, slot: 1 }), row({ block: 1, slot: 3 }), row({ block: 1, slot: 1, scored: false }), row({ block: 1, slot: 2 })])).toEqual({ block: 1, slot: 2 });
  });
  it('returns null when nothing is scored', () => {
    expect(selectTraceKey([row({ scored: false })])).toBeNull();
  });
});

describe('properties', () => {
  const caseArb = fc.record({ id: fc.constantFrom(START_CASE, INFLIGHT_CASE, 'A8.live-updates', 'A6.exhausted-fails'), passed: fc.boolean(), detail: fc.constantFrom('', ATTEMPTS, 'timed out') });
  const rowArb = fc.record({
    conditionId: fc.constantFrom('solo.AC.on', 'solo.AC.off', 'pi.AF-AC.on'),
    block: fc.integer({ min: 1, max: 10 }),
    slot: fc.integer({ min: 1, max: 24 }),
    scored: fc.boolean(),
    accepted: fc.boolean(),
    buildOk: fc.boolean(),
    cases: fc.array(caseArb, { maxLength: 6 }),
    checkRuns: fc.array(fc.record({ status: fc.constantFrom('passed', 'failed'), failedSuites: fc.subarray(['build', 'smoke', 'contract']) }), { maxLength: 3 }),
  });

  it('every scored workflow lands in exactly one class', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 40 }), (rows) => {
        const t = rejectionTable(rows);
        const scored = rows.filter((r) => r.scored).length;
        expect(t.reduce((n, c) => n + c.scored, 0)).toBe(scored);
        for (const c of t) expect(c.accepted + c['build-failed'] + c['did-not-start'] + c['inflight-attempt-count-only'] + c.other).toBe(c.scored);
      }),
    );
  });

  it('results do not depend on record order', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), (rows) => {
        const rev = [...rows].reverse();
        expect(rejectionTable(rev)).toEqual(rejectionTable(rows));
        expect(checkRunTable(rev)).toEqual(checkRunTable(rows));
        expect(selectTraceKey(rev)).toEqual(selectTraceKey(rows));
      }),
    );
  });

  it('check-run counts are consistent', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), (rows) => {
        const t = checkRunTable(rows);
        expect(t.passedRuns + t.failedRuns).toBe(t.runs);
        expect(t.finalPassedAccepted + t.finalPassedRejected + t.finalFailed).toBe(t.workflowsWithChecks);
      }),
    );
  });
});
