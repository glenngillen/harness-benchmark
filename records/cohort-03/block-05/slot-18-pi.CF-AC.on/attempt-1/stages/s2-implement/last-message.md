The job tracker is implemented. `npm run build` compiles cleanly, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What changed** (only `src/` and `ui/`; the fixed files and `checks/` are untouched):

- **`src/db.ts`**: opens the database as before, then creates the `jobs` and `worker_state` tables with `IF NOT EXISTS`. Adds a `BEGIN IMMEDIATE` transaction helper and the queries both processes use. The idempotency key is a `UNIQUE` column.
- **`src/jobs.ts`** (new): public job types, validation that collects every offending field, idempotency key checks, payload normalization, and `serializeJob`, which produces the exact public shape.
- **`src/server.ts`**: routing with 404/405 JSON errors, body reading with a 64 KB cap, atomic create-or-replay (200/201/409), `/health` based on the worker heartbeat, and graceful shutdown with a 5 s bound on draining connections.
- **`src/worker.ts`**: claims the oldest eligible queued job, commits progress after every step, handles transient failures with a persisted 500 ms `available_at` delay, recovers `running` rows at startup, writes a heartbeat every 500 ms, and shuts down at step boundaries.
- **`ui/index.html`**: form with all required `data-testid` hooks, `novalidate`, and `textContent` rendering. Polling runs every 500 ms and is serialized so responses apply in order.

**Verification:** I wrote a scenario script in `$TMPDIR`, outside the repo. It passed 57 of 57 checks. It covered validation, routing, idempotency under concurrency and across restarts, processing and Unicode uppercasing, retries for `failAttempts` 0/2/3/5, a worker SIGKILL during attempt 3 of a `failAttempts: 2` job (it recovered without consuming an extra attempt), `/health` going `down` after the heartbeat expired, SIGTERM and SIGKILL restarts, and prompt worker shutdown.

**Not verified:**
- I did not open the page in a real browser. I only confirmed that its inline script parses.
- The hidden evaluation may check things the scenario script does not.

**Choices I made:**
- An unknown key is reported in `fields` under its own name.
- A replayed attempt after a crash keeps its existing attempt number, as the plan specifies.
- A worker shutdown mid-attempt leaves the row `running`, and the next start recovers it.

**Environment note:** port 3917 is held by a process I cannot see from this sandbox. It answers `/health` with a worker up and holds about 131 jobs. I did not touch it, and my tests use random ports.