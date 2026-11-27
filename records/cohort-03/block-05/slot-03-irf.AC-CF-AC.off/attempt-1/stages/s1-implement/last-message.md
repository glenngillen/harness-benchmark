The job tracker is implemented. `npm run build` passes, and both fixed check suites pass (smoke 2/2, contract 5/5). I also tested the failure, restart, and validation paths by hand. The browser page is not tested in a real browser.

**What changed** (only `src/` and `ui/`; nothing else is modified and nothing is committed):
- **`src/db.ts`**: opens SQLite in WAL mode with a busy timeout and creates the schema: `jobs`, plus a `workers` heartbeat table.
- **`src/server.ts`**: routes, validation, idempotency, and `/health`. Idempotent creates run inside a `BEGIN IMMEDIATE` transaction, so a key can't create two jobs.
- **`src/worker.ts`**: claims the oldest runnable job with an atomic UPDATE, runs 100 ms steps with progress writes, handles retries (500 ms delay, 3 attempts), and heartbeats once a second.
- **`ui/index.html`**: the form and list with the required `data-testid`s, polling `/api/jobs` every second.

**Checked by hand:**
- `failAttempts: 3` ends `failed` with `attempts: 3`.
- SIGKILL of the worker mid-job: `/health` reported `worker: up` for about 3 s, then the restarted worker completed the job as `LONG JOB`.
- Validation: unknown fields, wrong types, whitespace-only input, bad `Idempotency-Key`, malformed JSON, and missing or wrong Content-Type all return 400 with the right `fields`.
- Idempotency: same key and payload returns 200, a different payload returns 409.
- Both processes exit cleanly on SIGTERM.

**Choices you may want to review:**
- **Interrupted attempts are not counted.** If a worker stops mid-attempt (SIGTERM or SIGKILL), that attempt is rolled back so `attempts` decrements and the job reruns as the same attempt number. This keeps the 3-attempt cap intact after a crash.
- **Recovery is heartbeat-based.** A job claimed by a worker whose heartbeat is more than 5 s old is requeued. Multiple workers are safe, and a live worker's jobs are never taken.
- **Retry delay** is a fixed 500 ms, inside the allowed 250 ms–2 s range.
- **Empty `steps` or `failAttempts` fields** in the UI are omitted so the API defaults apply. Non-numeric text is sent as typed so the API rejects it.
- **Request bodies over 64 KB** return 400 `invalid_request` on `body`.