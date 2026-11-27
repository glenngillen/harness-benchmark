The job tracker is built and both check suites pass: `npm run check:smoke` is 2/2 and `npm run check:contract` is 5/5. I did not commit anything.

**What changed** (only `src/` and `ui/`):
- `src/db.ts`: opens the database and creates the schema (`jobs`, `idempotency_keys`, `heartbeats`).
- `src/store.ts` (new): all reads and writes, shared by server and worker. Claims and idempotent creates run in `BEGIN IMMEDIATE` transactions.
- `src/validate.ts` (new): request validation. It reports every offending field, not just the first.
- `src/server.ts`: all routes, the 400/404/405/409 errors, idempotency, `/health` with worker status from the heartbeat, and clean `SIGTERM` shutdown.
- `src/worker.ts`: polls every 200 ms, runs one job at a time, writes progress after each 100 ms step, retries failed attempts after 500 ms, and heartbeats every second.
- `ui/index.html`: the form and job list with every required `data-testid`. It polls the list every second.

**Manual checks** (on a fresh database, not covered by the fixed suites):
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- A job at 4/20 steps survived a SIGKILL of both processes. After restart it completed with `LONG ONE` and no duplicate.
- Validation, 409 conflict, 404 and 405 responses, and `worker: "down"` after the worker stops all behave as specified.
- The page's inline script parses, but I did not load it in a real browser.

**Choices you may want to revisit:**
- **Interrupted attempts are not counted.** When the worker dies or stops mid-attempt, that attempt is rolled back, so the job reruns with the same attempt number. This keeps the "3 attempts total" and `failAttempts` rules exact across crashes. The alternative is to count the interrupted attempt, which would change which attempt fails.
- **Oversized bodies** (over 16 KB) return `400` with field `body`. The spec doesn't cover that case.

**Incident:** early in testing, port 3917 was already held by another process. My server failed to start, so some of my first requests reached that process. I did not touch it. My later tests used a free port and fresh database, and those are the results above.