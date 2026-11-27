import type { Clock } from './types.ts';

/** The app under evaluation did not behave as the contract requires. Always a rejection. */
export class CaseFailure extends Error {
  override name = 'CaseFailure';
}

/** The app could not be reached (refused, reset, or timed out). App-caused, so also a rejection. */
export class AppUnreachable extends CaseFailure {
  override name = 'AppUnreachable';
}

/** The evaluation ceiling was reached. App-caused. */
export class CeilingReached extends CaseFailure {
  override name = 'CeilingReached';
  constructor() {
    super('evaluation ceiling reached');
  }
}

/** The evaluator itself could not operate (browser launch, port allocation, missing fixtures). Operational, not scored. */
export class InfrastructureError extends Error {
  override name = 'InfrastructureError';
}

export function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new CaseFailure(detail);
}

export function checkEqual<T>(observed: T, expected: T, what: string): void {
  if (!Object.is(observed, expected)) {
    throw new CaseFailure(`${what}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
  }
}

export interface Deadline {
  clock: Clock;
  /** Absolute clock time of the evaluation ceiling. */
  at: number;
}

export function ensureTime(d: Deadline): void {
  if (d.clock.now() >= d.at) throw new CeilingReached();
}

/**
 * Polls `probe` until it returns a value other than undefined. Exceptions from the probe propagate
 * immediately, so an unreachable app fails fast instead of waiting out the timeout. The wait is
 * clipped to the evaluation ceiling.
 */
export async function waitFor<T>(
  d: Deadline,
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
  intervalMs = 50,
): Promise<T> {
  const start = d.clock.now();
  const until = Math.min(start + timeoutMs, d.at);
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    const now = d.clock.now();
    if (now >= until) {
      if (now >= d.at) throw new CeilingReached();
      throw new CaseFailure(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await d.clock.sleep(Math.min(intervalMs, until - now));
  }
}
