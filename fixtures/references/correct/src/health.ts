export const HEARTBEAT_STALE_MS = 3000;

export function workerIsUp(lastHeartbeat: number | undefined, now: number): boolean {
  return lastHeartbeat !== undefined && now - lastHeartbeat <= HEARTBEAT_STALE_MS;
}
