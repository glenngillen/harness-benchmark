import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatFeedback, renderRepairPrompt, truncateUtf8, TRUNCATION_MARKER } from '../../src/feedback/feedback.ts';
import type { CheckRun, SuiteOutcome } from '../../src/feedback/types.ts';

const suite = (s: Partial<SuiteOutcome> & Pick<SuiteOutcome, 'suite' | 'status'>): SuiteOutcome => ({
  checks: [],
  output: [],
  stderr: { server: [], worker: [] },
  durationMs: 1,
  ...s,
});

function run(suites: SuiteOutcome[], status: CheckRun['status'] = 'failed'): CheckRun {
  return {
    schema: 'harness-benchmark/check-run@1',
    status,
    reason: null,
    startedAt: '2026-11-14T00:00:00.000Z',
    durationMs: 10,
    ceilingMs: 120_000,
    snapshotHash: null,
    fixedFileChanges: [],
    suites,
  };
}

const failingContract = run([
  suite({ suite: 'build', status: 'passed', checks: [{ name: 'build.compile', title: 'TypeScript compiles', passed: true, detail: '' }] }),
  suite({ suite: 'smoke', status: 'passed', checks: [{ name: 'smoke.health', title: 'health', passed: true, detail: '' }] }),
  suite({
    suite: 'contract',
    status: 'failed',
    checks: [
      { name: 'contract.submit-job', title: 'submit', passed: true, detail: '' },
      { name: 'contract.retry-transient', title: 'retry', passed: false, detail: 'finished job attempts: expected 2, observed 1' },
    ],
    stderr: { server: ['listening on 3000'], worker: ['Error: boom', 'api_key=sk-live-123 leaked'] },
  }),
]);

const opts = { repairsLeft: 1, stageMinutesLeft: 12.34, maxBytes: 4000, replacements: { '/private/var/w/app': '.' } };

describe('formatFeedback', () => {
  it('lists each failing check with suite, name and expected versus observed, plus budgets', () => {
    const text = formatFeedback(failingContract, opts);
    expect(text).toContain('1 of 4 checks failed');
    expect(text).toContain('[contract] contract.retry-transient: FAILED');
    expect(text).toContain('finished job attempts: expected 2, observed 1');
    expect(text).not.toContain('contract.submit-job');
    expect(text).toContain('Sensor repairs remaining after this one: 1');
    expect(text).toContain('Stage minutes remaining: 12.3');
  });

  it('includes the last stderr lines of the failing suite, with secrets redacted', () => {
    const text = formatFeedback(failingContract, opts);
    expect(text).toContain('Worker stderr (contract suite, last 2 lines)');
    expect(text).toContain('Error: boom');
    expect(text).toContain('api_key=[redacted]');
    expect(text).not.toContain('sk-live-123');
  });

  it('shows compiler output for a failed build and marks the app suites as not run', () => {
    const r = run([
      suite({
        suite: 'build',
        status: 'failed',
        checks: [{ name: 'build.compile', title: 'TypeScript compiles', passed: false, detail: 'npm run build exited with code 2' }],
        output: ['/private/var/w/app/src/server.ts(3,1): error TS2304: Cannot find name x.'],
      }),
      suite({ suite: 'smoke', status: 'not-run' }),
      suite({ suite: 'contract', status: 'not-run' }),
    ]);
    const text = formatFeedback(r, opts);
    expect(text).toContain('[build] build.compile: FAILED');
    expect(text).toContain('./src/server.ts(3,1): error TS2304');
    expect(text).not.toContain('/private/var/w');
    expect(text).toContain('[smoke] not run: the build failed');
    expect(text).toContain('[contract] not run: the build failed');
  });

  it('reports a suite that hit the check ceiling', () => {
    const r = run([suite({ suite: 'build', status: 'passed' }), suite({ suite: 'smoke', status: 'passed' }), suite({ suite: 'contract', status: 'timed-out' })]);
    expect(formatFeedback(r, opts)).toContain('[contract] did not finish within the 120 s check ceiling');
  });

  it('never exceeds the byte limit, marking truncation', () => {
    const long = run([
      suite({ suite: 'build', status: 'passed' }),
      suite({ suite: 'smoke', status: 'failed', checks: [{ name: 'smoke.health', title: 'h', passed: false, detail: 'x'.repeat(300) }], stderr: { server: Array(40).fill('é'.repeat(200)), worker: [] } }),
      suite({ suite: 'contract', status: 'passed' }),
    ]);
    const text = formatFeedback(long, opts);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4000);
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(text).toContain('Sensor repairs remaining after this one: 1');
  });
});

describe('truncateUtf8', () => {
  it('leaves short text unchanged', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
  });

  describe('properties', () => {
    it('fits the byte limit, is a prefix plus marker when cut, and never splits a character', () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary', maxLength: 400 }), fc.integer({ min: Buffer.byteLength(TRUNCATION_MARKER), max: 600 }), (s, max) => {
          const out = truncateUtf8(s, max);
          expect(Buffer.byteLength(out)).toBeLessThanOrEqual(max);
          if (Buffer.byteLength(s) <= max) expect(out).toBe(s);
          else {
            expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
            expect(s.startsWith(out.slice(0, -TRUNCATION_MARKER.length))).toBe(true);
            const cut = out.length - TRUNCATION_MARKER.length;
            const last = s.charCodeAt(cut - 1);
            const next = s.charCodeAt(cut);
            expect(last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff).toBe(false);
          }
        }),
      );
    });

    it('formatFeedback output always fits and never leaks a redacted secret value', () => {
      const detail = fc.string({ maxLength: 200 });
      fc.assert(
        fc.property(fc.array(detail, { maxLength: 6 }), fc.array(detail, { maxLength: 50 }), fc.integer({ min: 200, max: 5000 }), (details, lines, maxBytes) => {
          const r = run([
            suite({ suite: 'build', status: 'passed' }),
            suite({ suite: 'smoke', status: 'passed' }),
            suite({
              suite: 'contract',
              status: 'failed',
              checks: details.map((d, i) => ({ name: `contract.c${i}`, title: 't', passed: false, detail: d })),
              stderr: { server: lines, worker: ['token=SECRETVALUE'] },
            }),
          ]);
          const text = formatFeedback(r, { ...opts, maxBytes });
          expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxBytes);
          expect(text).not.toContain('SECRETVALUE');
        }),
      );
    });
  });
});

describe('renderRepairPrompt', () => {
  it('fills the feedback and repairs-left placeholders of the frozen template', () => {
    const out = renderRepairPrompt('A\n{{FEEDBACK}}\nleft: {{REPAIRS_LEFT}}.', 'FB {{REPAIRS_LEFT}}', 0);
    expect(out).toBe('A\nFB {{REPAIRS_LEFT}}\nleft: 0.');
  });

  it('rejects a template without the placeholders', () => {
    expect(() => renderRepairPrompt('nothing', 'fb', 1)).toThrow(/placeholder/);
  });
});
