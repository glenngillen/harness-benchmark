import type { DatabaseSync } from 'node:sqlite';

/** How long a claimed job stays reserved without a progress update. */
export const LEASE_MS = 5000;

/** Single-worker deployment: anything left running belongs to a dead worker. Returns jobs requeued. */
export function recoverInterrupted(db: DatabaseSync, now: number): number {
  const result = db
    .prepare(
      "UPDATE jobs SET status = 'queued', lease_until = NULL, available_at = ?, updated_at = ? WHERE status = 'running'",
    )
    .run(now, new Date(now).toISOString());
  return Number(result.changes);
}
