The job tracker is implemented and both check suites pass: smoke 2/2 and contract 5/5. The app builds, and the server and worker start and shut down cleanly on SIGTERM. I did not commit anything.

**What changed** (only under `src/` and `ui/`; the fixed files and `checks/` are untouched)
- **`src/db.ts`**: opens the database and creates the schema: `jobs`, `idempotency_keys`, and `heartbeats`. The WAL and busy-timeout setup is kept.
- **`src/jobs.ts`** (new): timing constants and the mapping from a stored row to the job JSON shape.
- **`src/validate.ts`** (new): request validation. It collects every offending field rather than stopping at the first.
- **`src/server.ts`**: routing, `405` and `404` handling, idempotent job creation inside a `BEGIN IMMEDIATE` transaction, and `/health`, which reports the worker up if its heartbeat is under 3 s old.
- **`src/worker.ts`**: claims the oldest due queued job, runs the steps while updating progress after each one, and handles simulated failures with retries via a `run_after` timestamp. It writes a heartbeat every second and, on startup, requeues any job left `running`.
- **`ui/index.html`**: the form and the job list with all the required `data-testid` hooks. It polls every 500 ms and shows API errors in `form-error`.

**Checks I ran beyond the suites**
- Failure path: `failAttempts: 3` ends `failed` with `attempts: 3` and `"transient failure"`. `failAttempts: 2` completes on attempt 3.
- Validation: unknown fields, a numeric string, a non-integer, whitespace-only input, a missing or wrong `Content-Type`, a non-object body, and a bad `Idempotency-Key` all return `400` with the right fields.
- Idempotency: the same key and payload returns `200` with the same job, a different payload returns `409`, and only one job is created.
- Durability: I SIGKILLed both processes while a 20-step job was at 8/20. After restart it completed once, with `attempts: 2`, within a few seconds.

**Choices I made that you may want to change**
- A retry delay of 500 ms.
- An interrupted attempt still counts toward `attempts`, so after a crash the next run is attempt n+1 and the job is not resumed mid-way.
- On graceful shutdown, an in-progress job goes back to `queued` immediately rather than waiting for the next start.
- Bodies over 64 KiB are rejected with `400` on the `body` field.
- The UI sends numeric-looking text as numbers and omits empty fields so the API defaults apply.

I did not test the page in a real browser, so the UI is verified by reading the code and the `data-testid` grep only.