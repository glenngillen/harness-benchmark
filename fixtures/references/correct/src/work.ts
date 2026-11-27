/** Simulated duration of one processing step. */
export const STEP_MS = 100;

export function computeOutput(input: string): string {
  return input.toUpperCase();
}

/** Attempt numbers start at 1; the first `failAttempts` attempts fail transiently. */
export function shouldFailAttempt(attempt: number, failAttempts: number): boolean {
  return attempt <= failAttempts;
}
