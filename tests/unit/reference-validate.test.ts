import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  validateSubmission,
  validateIdempotencyKey,
  DEFAULT_STEPS,
  DEFAULT_FAIL_ATTEMPTS,
} from '../../fixtures/references/correct/src/validate.ts';

const validInput = fc
  .string({ minLength: 1, maxLength: 1000 })
  .filter((s) => s.trim().length > 0);

describe('validateSubmission', () => {
  it('applies defaults for omitted optional fields', () => {
    expect(validateSubmission({ input: 'hello' })).toEqual({
      ok: true,
      value: { input: 'hello', steps: DEFAULT_STEPS, failAttempts: DEFAULT_FAIL_ATTEMPTS },
    });
  });

  it.each([
    [null, 'body'],
    [[], 'body'],
    ['text', 'body'],
    [{}, 'input'],
    [{ input: '' }, 'input'],
    [{ input: '   ' }, 'input'],
    [{ input: 'x'.repeat(1001) }, 'input'],
    [{ input: 3 }, 'input'],
    [{ input: 'a', steps: 0 }, 'steps'],
    [{ input: 'a', steps: 21 }, 'steps'],
    [{ input: 'a', steps: 2.5 }, 'steps'],
    [{ input: 'a', steps: '3' }, 'steps'],
    [{ input: 'a', failAttempts: -1 }, 'failAttempts'],
    [{ input: 'a', failAttempts: 6 }, 'failAttempts'],
    [{ input: 'a', colour: 'red' }, 'colour'],
  ])('rejects %j on field %s', (body, field) => {
    const result = validateSubmission(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });

  it('accepts every in-range submission unchanged', () => {
    fc.assert(
      fc.property(validInput, fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 5 }), (input, steps, failAttempts) => {
        expect(validateSubmission({ input, steps, failAttempts })).toEqual({ ok: true, value: { input, steps, failAttempts } });
      }),
    );
  });

  it('rejects any unknown field', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) => !['input', 'steps', 'failAttempts', '__proto__'].includes(k)),
        fc.anything(),
        (key, value) => {
          const body: Record<string, unknown> = { input: 'ok' };
          body[key] = value;
          const result = validateSubmission(body);
          expect(result.ok).toBe(false);
        },
      ),
    );
  });

  it('never throws and always returns a verdict for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        const result = validateSubmission(body);
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
      }),
    );
  });
});

describe('validateIdempotencyKey', () => {
  it('treats an absent header as no key', () => {
    expect(validateIdempotencyKey(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('accepts keys matching the documented pattern', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{1,128}$/), (key) => {
        expect(validateIdempotencyKey(key)).toEqual({ ok: true, value: key });
      }),
    );
  });

  it.each([[''], ['has space'], ['x'.repeat(129)], [['a', 'b']], ['ünïcode']])('rejects %j', (key) => {
    expect(validateIdempotencyKey(key).ok).toBe(false);
  });
});
