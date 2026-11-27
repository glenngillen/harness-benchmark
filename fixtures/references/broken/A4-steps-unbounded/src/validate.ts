export const DEFAULT_STEPS = 5;
export const DEFAULT_FAIL_ATTEMPTS = 0;
export const MAX_INPUT_LENGTH = 1000;
const ALLOWED = new Set(['input', 'steps', 'failAttempts']);
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface Submission {
  input: string;
  steps: number;
  failAttempts: number;
}
export interface FieldError {
  field: string;
  message: string;
}
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export function validateSubmission(body: unknown): Validated<Submission> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: 'body', message: 'must be a JSON object' }] };
  }
  const record = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) errors.push({ field: key, message: 'unknown field' });
  }
  const { input } = record;
  if (typeof input !== 'string' || input.length < 1 || input.length > MAX_INPUT_LENGTH || input.trim().length === 0) {
    errors.push({ field: 'input', message: `must be a string of 1-${MAX_INPUT_LENGTH} characters, not only whitespace` });
  }
  const steps = record.steps ?? DEFAULT_STEPS;
  if (!intInRange(steps, 1, Number.MAX_SAFE_INTEGER)) errors.push({ field: 'steps', message: 'must be an integer from 1 to 20' });
  const failAttempts = record.failAttempts ?? DEFAULT_FAIL_ATTEMPTS;
  if (!intInRange(failAttempts, 0, 5)) errors.push({ field: 'failAttempts', message: 'must be an integer from 0 to 5' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { input: input as string, steps: steps as number, failAttempts: failAttempts as number } };
}

export function validateIdempotencyKey(header: string | string[] | undefined): Validated<string | undefined> {
  if (header === undefined) return { ok: true, value: undefined };
  if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
    return { ok: false, errors: [{ field: 'Idempotency-Key', message: 'must match [A-Za-z0-9_-]{1,128}' }] };
  }
  return { ok: true, value: header };
}
