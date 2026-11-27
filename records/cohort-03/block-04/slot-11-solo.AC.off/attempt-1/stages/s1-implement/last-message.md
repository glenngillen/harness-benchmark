The job tracker is built, and both fixed check suites pass (`npm run build`, `check:smoke` 2/2, `check:contract` 5/5). I also ran the server and worker by hand for the cases the checks don't cover, and they behaved as specified. I did not open the page in a real browser, so the UI is checked only by reading the code and by the `data-testid` hooks being present.

**What changed**
- **`src/db.ts`**: opens the SQLite database and creates the schema: a `jobs` table, a unique index on `idempotency_key`, and a `heartbeats` table.
- **`src/jobs.ts`** (new): the job row-to-JSON mapping and request validation. Validation collects every offending field, not just the first.
- **`src/server.ts`**: the HTTP API, routing (404 and 405 with an `Allow` header), `Content-Type` and body checks, and the idempotency check and insert, run in one `BEGIN IMMEDIATE` transaction. `/health` reports the worker as `up` when its heartbeat is at most 3 seconds old.
- **`src/worker.ts`**: picks the oldest eligible queued job, runs steps of 100 ms with progress written after each step, and handles the simulated failures and retries (3 attempts total, retry delay 250–2000 ms). It writes a heartbeat every second and requeues `running` jobs on startup.
- **`ui/index.html`**: the form and job list with the required `data-testid` attributes. It polls `/api/jobs` every second and shows API rejections, including field names, in `form-error`.

**Verified by hand**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- Idempotent replay returns 200, and a different payload returns 409.
- A job whose worker was SIGKILLed mid-run was processed again after restart and completed with `attempts: 2`.
- An idempotency key still replays after a full restart.
- Both processes exit on SIGTERM.

**Choices I made**
- A graceful shutdown mid-job requeues that job immediately. The interrupted attempt still counts in `attempts`.
- Idempotency is a unique column on `jobs`, not a separate table.
- Request bodies are capped at 64 KB. Larger bodies get a 400 with field `body`.
- Only one worker is supported. A second worker starting would requeue a job the first is still running.

**Something to know:** while testing, I found another process on this machine already listening on port 3917, with its own database. My first attempt used that port by mistake and queried that process's data. I did not touch it, and my final tests used a free port and a fresh database. You may want to check whether that process is yours.