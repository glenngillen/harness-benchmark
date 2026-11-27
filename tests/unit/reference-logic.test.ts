import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeOutput, shouldFailAttempt } from '../../fixtures/references/correct/src/work.ts';
import { MAX_ATTEMPTS, backoffMs, decideAfterFailure } from '../../fixtures/references/correct/src/retry.ts';
import { fingerprint } from '../../fixtures/references/correct/src/fingerprint.ts';
import { workerIsUp, HEARTBEAT_STALE_MS } from '../../fixtures/references/correct/src/health.ts';

const submission = fc.record({
  input: fc.string({ minLength: 1, maxLength: 50 }),
  steps: fc.integer({ min: 1, max: 20 }),
  failAttempts: fc.integer({ min: 0, max: 5 }),
});

describe('work', () => {
  it('upper-cases the input', () => {
    expect(computeOutput('Hello, world')).toBe('HELLO, WORLD');
  });

  it('is idempotent', () => {
    fc.assert(fc.property(fc.string(), (s) => computeOutput(computeOutput(s)) === computeOutput(s)));
  });

  it('fails exactly the first failAttempts attempts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 0, max: 5 }), (attempt, failAttempts) => {
        expect(shouldFailAttempt(attempt, failAttempts)).toBe(attempt <= failAttempts);
      }),
    );
  });
});

describe('retry', () => {
  it('allows three attempts in total', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(decideAfterFailure(1, 1000)).toEqual({ kind: 'retry', availableAt: 1000 + backoffMs(1) });
    expect(decideAfterFailure(2, 1000)).toEqual({ kind: 'retry', availableAt: 1000 + backoffMs(2) });
    expect(decideAfterFailure(3, 1000)).toEqual({ kind: 'fail' });
  });

  it('backs off by a positive, non-decreasing delay', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (a) => backoffMs(a) > 0 && backoffMs(a + 1) >= backoffMs(a)),
    );
  });

  it('never schedules a retry in the past', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 0, max: 2 ** 45 }), (attempts, now) => {
        const d = decideAfterFailure(attempts, now);
        return d.kind === 'fail' ? attempts >= MAX_ATTEMPTS : d.availableAt > now;
      }),
    );
  });
});

describe('fingerprint', () => {
  it('is equal exactly when the normalised submissions are equal', () => {
    fc.assert(
      fc.property(submission, submission, (a, b) => {
        const same = a.input === b.input && a.steps === b.steps && a.failAttempts === b.failAttempts;
        expect(fingerprint(a) === fingerprint(b)).toBe(same);
      }),
    );
  });
});

describe('health', () => {
  it('reports the worker up only with a fresh heartbeat', () => {
    expect(workerIsUp(undefined, 10_000)).toBe(false);
    expect(workerIsUp(10_000 - HEARTBEAT_STALE_MS, 10_000)).toBe(true);
    expect(workerIsUp(10_000 - HEARTBEAT_STALE_MS - 1, 10_000)).toBe(false);
  });
});
