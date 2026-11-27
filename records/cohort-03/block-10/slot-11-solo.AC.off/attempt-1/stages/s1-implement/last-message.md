Both processes build and run, and the fixed checks pass. I did not commit anything.

**What's in place**

- **`src/db.ts`**: opens the shared SQLite file in WAL mode, creates the `jobs` and `worker_heartbeat` tables, and makes the parent directory.
- **`src/jobs.ts`**: a `JobStore` holding all SQL and state transitions. Writes run in `BEGIN IMMEDIATE` transactions. Idempotency keys are a `UNIQUE` column, so they hold across restarts.
- **`src/validation.ts`**: checks the body and `Idempotency-Key` and reports every offending field in one `400`.
- **`src/server.ts`**: the HTTP API, `/health`, and the UI route. It closes cleanly on `SIGTERM`.
- **`src/worker.ts`**: claims the oldest eligible job, runs its steps (100 ms each, progress saved after each), and handles simulated failures. It writes a heartbeat every 500 ms and requeues any `running` job at startup.
- **`ui/index.html`**: the form, the job list, and the required `data-testid` hooks. It polls `/api/jobs` every second.

**Checks run**

- `npm run build`: clean.
- `npm run check:smoke`: 2/2 passed.
- `npm run check:contract`: 5/5 passed.
- Manual runs covered:
  - validation and routing responses;
  - `failAttempts: 3` ending `failed` with `attempts: 3`;
  - `SIGKILL` of the worker mid-job, then restart, with the job finishing;
  - idempotency replay and conflict across a server restart;
  - `/health` reporting `worker: down` about 3 s after the worker is killed.

**Choices I made where the spec was open**

- A job interrupted by a crash counts that attempt toward `attempts`, and is reprocessed as the next attempt.
- The retry delay is a fixed 500 ms, inside the allowed 250 ms–2 s range.
- A failed attempt is requeued rather than the worker sleeping in place.
- On `SIGTERM` the worker stops after the current step and leaves the job `running`, so the next start recovers it.

**Not verified**

- I did not open the UI in a real browser. The page logic was written against the spec and has not been exercised in one.
- One early idempotency run returned `409` for all three requests, including the first. I could not reproduce it: a clean rerun gave `201`, `200`, `409` with one stored job. I could not determine the cause of the first result. The database file I inspected afterwards did not match what the server had written, which points to my test setup rather than the code, but I have not confirmed that.