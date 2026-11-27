The job tracker is implemented. `npm run build` is clean, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. Changes are uncommitted, and the only files touched are under `src/` and `ui/`.

**What changed**
- **`src/db.ts`**: keeps the existing WAL/busy-timeout setup and now creates the `jobs` and `worker_heartbeat` tables.
- **`src/store.ts`** (new): the SQL shared by both processes. Submission and idempotency run in one `BEGIN IMMEDIATE` transaction, and job claiming is atomic.
- **`src/validate.ts`** (new): request validation. It collects every offending field and covers the body-level cases (bad JSON, non-object, wrong Content-Type) and the `Idempotency-Key` format.
- **`src/server.ts`**: the full HTTP API, with 404/405 handling and clean `SIGTERM`/`SIGINT` shutdown. `/health` reports the worker as `up` only if its heartbeat is at most 3 seconds old.
- **`src/worker.ts`**: polls every 200 ms, writes a heartbeat every second, runs attempts with 100 ms steps, and updates progress after each step. Transient failures re-queue after 500 ms and fail on attempt 3.
- **`ui/index.html`**: the form and job list with the required `data-testid` hooks. It polls `/api/jobs` every second and shows API rejections, field names included, in `form-error`.

**Choices I made where the spec was open**
- **Crash recovery uses a lease.** A running job's lease is refreshed each step. The worker re-queues any job whose lease has expired, so a job interrupted by `SIGKILL` resumes within about 3 seconds of the restart.
- **The interrupted attempt still counts toward `attempts`.** This follows the literal "attempts started" definition. The retry cap is applied to the attempt number, so a crash can't push a job past attempt 3 without it failing.
- **Graceful shutdown releases the in-flight job** back to `queued` rather than leaving it to lease expiry.
- **Retry delay is a fixed 500 ms**, within the 250 ms–2 s range.

**Verification beyond the fixed checks**
I wrote a separate end-to-end script in `$TMPDIR`, outside the repo. It runs on a free port and covers the validation rules, the 1000/1001-character boundary, the `failAttempts` 2 and 3 cases, idempotency including replay after restart, progress visibility, and SIGKILL of the worker mid-job and of the server. All 32 checks passed.

**Not verified**
- I did not load the UI in a real browser. I checked the markup and script by reading them.
- The fixed checks don't cover the browser page or persistence, so the hidden evaluation may still find gaps in those areas.

One note from testing: while running the first ad-hoc tests, port 3917 was held by an unrelated process, and I briefly tested against it by mistake. Those results were discarded, and I did not touch that process.