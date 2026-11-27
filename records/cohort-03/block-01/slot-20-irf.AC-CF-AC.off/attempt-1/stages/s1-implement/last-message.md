The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I also tested the cases the fixed checks don't cover, against a live server and worker.

**What I changed** (only `src/` and `ui/`):
- **`src/db.ts`**: opens the database in WAL mode with a busy timeout, creates the `jobs` and `worker_heartbeat` tables, and provides small query helpers.
- **`src/jobs.ts`** (new): constants, the job JSON mapping, and request validation. Validation collects every offending field and returns `body` for whole-body problems.
- **`src/server.ts`**: the HTTP API, `GET /` serving the page, and `/health` using the worker heartbeat (up if seen within 3 s). Idempotency keys are stored in the database, so they survive restarts.
- **`src/worker.ts`**: writes a heartbeat every second, re-queues jobs left `running` by a dead worker, and processes queued jobs oldest first. Each step takes 100 ms and updates progress. Failed attempts retry after 500 ms, up to 3 attempts in total.
- **`ui/index.html`**: the form and job list with the required `data-testid` attributes. It polls every second and renders with `textContent`.

**What I verified by hand:**
- Validation: string numbers, out-of-range values, unknown fields, malformed JSON, a non-object body, a missing content type, and a bad `Idempotency-Key` all return 400 with the right field names.
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- An idempotent replay after `kill -9` of both processes returns the original job with 200.
- A worker killed mid-job at 4/20 re-queues on restart and completes with the correct output.
- SIGTERM shuts both processes down.

**Not verified:** I could not run the browser page. I only syntax-checked its script, so the form and live refresh are untested in a real browser.

**Choices I made where the spec left room:**
- The retry delay is 500 ms.
- On graceful shutdown mid-job, the job goes back to `queued` and its attempt still counts.
- Request bodies over 64 KB are rejected as a `body` error.

The untracked dotfiles and `scripts/` directory were already in the repo, and I did not touch them.