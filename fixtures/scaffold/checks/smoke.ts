/**
 * Smoke checks: the server and worker start with the documented commands and the health
 * endpoint responds. Run with `npm run build && npm run check:smoke`.
 */
import { waitForHealth, type Check } from './core.ts';

/** The brief allows each process 10 seconds to start, and the heartbeat must be under 3 seconds old. */
const STARTUP_MS = 10_000;

export const SMOKE_CHECKS: readonly Check[] = [
  {
    name: 'smoke.health',
    title: 'npm run start:server starts and GET /health returns 200 {"status":"ok"} within 10 s',
    async run(ctx) {
      await waitForHealth(ctx, STARTUP_MS, false);
    },
  },
  {
    name: 'smoke.worker-up',
    title: 'npm run start:worker starts and GET /health reports "worker":"up" within 10 s',
    async run(ctx) {
      await waitForHealth(ctx, STARTUP_MS, true);
    },
  },
];
