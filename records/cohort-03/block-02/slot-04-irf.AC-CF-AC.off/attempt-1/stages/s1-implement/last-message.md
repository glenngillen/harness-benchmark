The job tracker is implemented in `src/` and `ui/`. It builds cleanly, and both check suites pass (smoke 2/2, contract 5/5). I also ran a manual end-to-end test of the behaviours the checks don't cover.

**What I changed**
- **`src/db.ts`**: the SQLite schema (`jobs` and `worker_heartbeat` tables), plus the shared helpers both processes use. Claims are atomic, using `BEGIN IMMEDIATE`.
- **`src/server.ts`**: routing with 404/405, validation with per-field errors, idempotency keys, `/health` based on the worker heartbeat, and the `/` page. Shuts down on SIGTERM/SIGINT.
- **`src/worker.ts`**: claims the oldest queued job, runs 100 ms steps with progress written after each one, and applies the retry rules. Writes a heartbeat every second and requeues interrupted jobs on startup.
- **`ui/index.html`**: the form and job list with the required `data-testid` hooks. It polls `/api/jobs` every second and shows API rejections in `form-error`, naming the offending fields.

**Manual checks that passed**
- Validation: unknown fields, `"3"` as steps, bad Content-Type, malformed JSON, and a bad `Idempotency-Key` each return 400 with the right field.
- Idempotency: same key and payload returns 200 with the original job, and a different payload returns 409.
- Retries: `failAttempts: 2` completes on attempt 3, and `failAttempts: 3` ends `failed` with `"transient failure"`.
- Restart: after `kill -9` of the worker mid-job, `/health` reports `worker: down` within about 3 seconds. A new worker requeues the interrupted job, which then completes. SIGTERM stops both processes cleanly.

**Choices I made where the spec was open**
- A job interrupted by a crash or shutdown does not count that attempt, so it is retried as the same attempt number.
- Retry delay is 500 ms.
- A body over 64 KB is rejected with 400 on the `body` field.
- The UI sends numeric-looking text as numbers and omits empty optional fields.

**Not verified**
- I did not test the UI in a real browser. The page logic is straightforward, but it has not been exercised.

**Note on port 3917:** early in testing, my first manual run hit a different server already listening on port 3917, which has its own database. I did not touch that process. I used port 3931 and then 3941 for my runs.