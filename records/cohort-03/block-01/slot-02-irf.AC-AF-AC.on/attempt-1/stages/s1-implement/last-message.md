The job tracker is implemented. `npm run build`, `check:smoke` (2/2), and `check:contract` (5/5) all pass. I also tested behaviour the checks don't cover, by hand against the running processes.

**What changed**
- **`src/db.ts`**: kept `openDatabase`, added the schema (`jobs` and `heartbeats` tables) and a `BEGIN IMMEDIATE` transaction helper.
- **`src/jobs.ts`** (new): validation, the job JSON shape, and all SQL for create, claim, progress, retry, recovery, and heartbeats. Both processes use it, so the database is the only shared state.
- **`src/server.ts`**: routing (404/405), body parsing and the 64 KiB cap, the `Idempotency-Key` check, `/health` with worker heartbeat staleness at 3 s, and graceful SIGTERM/SIGINT shutdown.
- **`src/worker.ts`**: claims the oldest due job, runs steps of 100 ms with progress written after each step, handles transient failures, requeues jobs left `running` on startup, and writes a heartbeat every second.
- **`ui/index.html`**: the form and list with the required `data-testid`s. It polls once a second, uses `textContent` only, and sends blank numeric fields as omitted so defaults apply.

**Verified by hand**
- Invalid inputs return 400 with the right field names, including the malformed-JSON, missing-Content-Type, and bad-key cases.
- `failAttempts` 3 and 5 both end `failed` after 3 attempts.
- Idempotent replay returns 200 and a changed payload returns 409. Both still hold after a SIGKILL restart.
- A job running when the worker is SIGKILLed is reprocessed and completes after restart.
- `worker` is `up` while the worker runs, and `down` once its heartbeat is more than 3 s old.
- SIGTERM exits both processes cleanly.

**Choices you may want to review**
- Retry delay is a fixed 500 ms, within the 250 ms–2 s range.
- A job interrupted by a clean shutdown is requeued immediately rather than waiting for the next worker start.
- A job interrupted by a crash keeps its counted attempt, so `attempts` can exceed 3 in that case.
- The worker does not block on a retry delay, so later queued jobs can run while a failed one waits.

**Not verified:** I could not run the page in a browser here. I only syntax-checked its inline script, so the form and live updates still need a real browser check.