import type { DatabaseSync } from 'node:sqlite';

/** How long a claimed job stays reserved without a progress update. */
export const LEASE_MS = 24 * 60 * 60 * 1000;

/** Single-worker deployment: anything left running belongs to a dead worker. Returns jobs requeued. */
export function recoverInterrupted(_db: DatabaseSync, _now: number): number {
  return 0;
}
