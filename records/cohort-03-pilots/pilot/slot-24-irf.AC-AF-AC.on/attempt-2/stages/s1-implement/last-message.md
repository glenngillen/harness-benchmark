The job tracker is implemented. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass on the final build. I also ran the server and worker by hand and checked the cases the fixed suites don't cover. I did not open the browser page; I only confirmed the markup and script by reading them.

**What changed** (under `src/` and `ui/` only; no fixed files touched, no dependencies added):

- **`src/db.ts`**: opens SQLite in WAL mode and creates the `jobs` and `meta` tables if missing. Both processes call this at startup.
- **`src/jobs.ts`** (new): shared constants (3 attempts, 100 ms steps, 500 ms retry delay, 3 s lease and heartbeat staleness) and the mapping from database rows to the job JSON shape.
- **`src/server.ts`**: `/health`, `GET`/`POST /api/jobs`, `GET /api/jobs/:id`, `/`, and the 404/405 handling. Validation collects every offending field. Idempotency runs inside `BEGIN IMMEDIATE`, so the lookup and insert are atomic across processes. Shutdown is on SIGTERM and SIGINT.
- **`src/worker.ts`**: claims the oldest due queued job in one atomic `UPDATE … RETURNING`, runs its steps, and writes progress after each step. It retries failed attempts with a delay and marks the job `failed` after the third. It writes a heartbeat about once per second, including during jobs.
- **`ui/index.html`**: the form and job list with all the required `data-testid` hooks. It polls every second and shows API rejections, including field names, in `form-error`.

**Choices I made where the brief left room:**

- **Crash recovery uses a lease, not a startup reset.** A running job's lease is renewed on every step. If the worker dies, the job becomes claimable about 3 seconds later, so a restarted worker reprocesses it well within the 10-second limit. This is also safe if two workers ever run at once.
- **Retry delay is a fixed 500 ms**, inside the 250 ms to 2 s range.
- **An empty steps or failAttempts field is omitted** from the UI request, so the API default applies. A non-numeric value is sent as text so the API rejects it.
- **Request bodies over 64 KB** are rejected with `400` on field `body`. The brief does not cover this case.

**Verified by hand:** `failAttempts: 3` ends `failed` with `attempts: 3`. A worker killed with SIGKILL mid-job has its job completed after restart with `attempts: 2`. Idempotent replays return 200 and conflicting payloads return 409, both with the same key after a server restart. Validation rejects whitespace-only input, wrong Content-Type, non-object bodies, and bad Idempotency-Key values. Both processes exit on SIGTERM.