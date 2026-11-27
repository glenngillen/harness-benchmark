import type { Submission } from './validate.ts';

/** Canonical identity of a submission after defaults are applied, used for idempotency comparison. */
export function fingerprint(s: Submission): string {
  return JSON.stringify([s.input, s.steps, s.failAttempts]);
}
