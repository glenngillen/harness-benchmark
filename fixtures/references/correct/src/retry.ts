export const MAX_ATTEMPTS = 3;

export function backoffMs(attempt: number): number {
  return 250 * attempt;
}

export type FailureDecision = { kind: 'retry'; availableAt: number } | { kind: 'fail' };

export function decideAfterFailure(attempts: number, now: number): FailureDecision {
  if (attempts >= MAX_ATTEMPTS) return { kind: 'fail' };
  return { kind: 'retry', availableAt: now + backoffMs(attempts) };
}
