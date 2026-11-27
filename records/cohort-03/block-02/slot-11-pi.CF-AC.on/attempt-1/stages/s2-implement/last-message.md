The job tracker is implemented in `src/` and `ui/`. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What changed**
- **`src/db.ts`**: opens the database (same `PRAGMA` order as before), creates the schema with `IF NOT EXISTS` inside a short transaction, and holds all SQL. Transitions are `BEGIN IMMEDIATE` transactions. There is a `jobs` table with a unique public id, a unique nullable idempotency key, and an `available_at` for retry delays. There is also a single-row `worker_heartbeat` table.
- **`src/jobs.ts`** (new): types, request validation (body, defaults, Idempotency-Key), and `toPublicJob`, which emits only the specified fields.
- **`src/server.ts`**: routing with 404/405, the create flow (validation first, then the idempotency lookup and insert in one transaction), `/health`, the `/` page, a structured 500, and graceful `SIGTERM`/`SIGINT` shutdown with a bounded grace period.
- **`src/worker.ts`**: heartbeat every 500 ms, a 100 ms poll, oldest-first claiming, 100 ms steps with progress committed after each one, retries with a 500 ms delay, and clean shutdown that clears the heartbeat and closes the database.
- **`ui/index.html`**: the form with all test IDs, `role="alert"` errors that name each field, a list rendered with `textContent` and updated in place, and single-flight polling every 500 ms.

**Manual checks** (a temporary database on a free port)
- `failAttempts: 5` ends `failed` with `attempts: 3` and zero progress. `failAttempts: 2` completes on attempt 3.
- Validation rejects an invalid `steps` string, an array root, unknown fields, malformed JSON, a missing Content-Type, and a bad Idempotency-Key. Each returns 400 with the offending field.
- Unsupported methods return 405, and unknown paths return 404.
- After `kill -9` of the worker, `/health` reports `worker: down` within about 3.5 s. After restart, a running 20-step job resumed and completed.
- Replaying a key returns 201 and then 200 with the same job, including after a server restart.
- Graceful `SIGTERM` exits both processes cleanly.

**Choices you may want to review**
- **Crash recovery** replays the interrupted attempt from step 1 and does not increment `attempts`. A job killed during attempt 3 therefore still ends on attempt 3, as the plan intended.
- **Blank or non-numeric steps/failAttempts** are sent as `null` and rejected by the API, not defaulted.
- **Request body** is capped at 1 MiB and rejected with a `body` field error.
- **Retry delay** is 500 ms.

**Not verified**
- I did not test the page in a real browser. I only syntax-checked its inline script, so the rendering and polling behaviour is unverified.
- My first manual run briefly hit another process already listening on port 3917. I discarded those results and re-ran everything on a free port.