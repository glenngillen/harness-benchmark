The job tracker is implemented. `npm run build` is clean, and both fixed suites pass: smoke 2/2 and contract 5/5. I did not commit anything.

**Changes**
- **`src/db.ts`**: creates the `jobs`, `idempotency`, and `heartbeats` tables on open, and adds a `transaction()` helper that takes the write lock up front (`BEGIN IMMEDIATE`) so the server and worker don't race.
- **`src/jobs.ts`** (new): shared constants (3 attempts, 500 ms retry delay, 100 ms per step), the row type, and the mapping to the public job JSON.
- **`src/server.ts`**: all routes and error shapes. Validation collects every bad field, including unknown fields, wrong types, non-integers, the Content-Type check, and the `Idempotency-Key` pattern. Idempotency is a fingerprint comparison inside one transaction, so a key creates at most one job, including across restarts. `/health` reports the worker as up if its heartbeat is under 3 s old. Shutdown closes the connections and the database.
- **`src/worker.ts`**: polls every 200 ms and claims the oldest runnable job atomically. It updates progress after each step and handles the simulated failure at the first step. Retries are re-queued with a delay, and the third failure marks the job `failed`. On startup it requeues any job left `running` by a crashed worker. It writes a heartbeat every 500 ms and clears it on shutdown.
- **`ui/index.html`**: the form and job list with every required `data-testid`. It polls `GET /api/jobs` every second, builds the DOM with `textContent` (no HTML injection), and shows API rejections, including field names, in `form-error`.

**Manual checks beyond the fixed suites** (all behaved as specified):
- Invalid-body cases: malformed JSON, arrays, a missing or wrong Content-Type, a bad key, whitespace-only input, a fractional `steps`, and an unknown field.
- 405 and 404 responses.
- `failAttempts: 3` ends `failed` with `transient failure` after 3 attempts.
- After `SIGKILL` of both processes and a restart, jobs persist, and an idempotency key still replays or conflicts correctly.
- A job killed mid-run at step 8 of 20 was reprocessed after the worker restarted and completed with `attempts: 2`.
- `/health` reports `worker: down` after the worker receives SIGTERM.

**Choices you may want to review**
- An attempt cut short by a graceful shutdown is re-queued without being retried in that process, and its attempt still counts toward `attempts`. This matches how crash recovery counts it.
- A repeated `Idempotency-Key` or `Content-Type` header is joined before validation, so it fails validation rather than being truncated.
- The page sends a blank numeric field as an omitted field, so the server default applies.