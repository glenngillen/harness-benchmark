The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass. I did not commit anything.

**What changed**

- **`src/db.ts`**: opens SQLite (WAL, busy timeout), creates the schema if missing, and creates the parent directory. Both processes use it.
- **`src/store.ts`** (new): all SQL. Job creation and idempotency-key lookup run in one `BEGIN IMMEDIATE` transaction. Claiming a job is a single atomic `UPDATE … RETURNING`.
- **`src/validation.ts`** (new): validates the body, applies defaults, and reports every offending field.
- **`src/server.ts`**: the HTTP API, the `/health` check (worker is `up` if its heartbeat is at most 3 s old), and `GET /`. It never runs jobs.
- **`src/worker.ts`**: claims the oldest due job, runs the steps at 100 ms each, updates progress after each step, retries failed attempts with a random 250–2000 ms delay, and writes a heartbeat every second. On shutdown it returns any running job to the queue.
- **`ui/index.html`**: the form and job list with the required `data-testid` hooks, polling every second.

**Checks beyond the fixed suites**

I ran a scratch end-to-end script outside the repo. It passed all of these:
- failure after 3 attempts, and completion on attempt 3 with `failAttempts: 2`;
- every validation case in the spec;
- idempotent replay (200) and conflict (409);
- 404 and 405 responses;
- SIGKILL of the worker and the server, followed by a restart. The running job was reprocessed and completed, and jobs persisted across restarts;
- clean exit 0 on SIGTERM for both processes.

I did not test the page in a real browser. I only confirmed the inline script parses.

**Judgment calls**

- An attempt interrupted by a crash or a graceful stop is not counted. Its `attempts` count is rolled back, so the 3-attempt limit holds and "attempts set to 3" stays true on failure.
- Port 3917 was held by a process outside this sandbox, so I ran the scratch test on a free port.