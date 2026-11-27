The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass. I did not commit anything.

**What changed**

- **`src/db.ts`**: Creates the schema on open (jobs, heartbeats) and adds a `BEGIN IMMEDIATE` transaction helper.
- **`src/jobs.ts`** (new): Job row mapping to the documented JSON shape, plus the constants (100 ms steps, 500 ms retry delay, 3 attempts).
- **`src/validate.ts`** (new): Submission validation with defaults applied, so idempotency compares the final payload.
- **`src/server.ts`**: All routes, the 400/404/405/409 error shapes, idempotency keyed by a unique column (so it survives restarts), and `/health` based on a worker heartbeat under 3 seconds old. Handles SIGTERM.
- **`src/worker.ts`**: Polls every 200 ms for the oldest due queued job, runs steps with per-step progress writes, and handles simulated failures and retries. Writes a heartbeat every second, and on startup re-queues any job left `running`. On SIGTERM it re-queues the in-progress job and exits.
- **`ui/index.html`**: Form and job list with the required `data-testid` attributes. It polls `/api/jobs` every second and shows API rejections, including field names, in `form-error`.

**Checks I ran by hand** (scratch database, live processes)

- `failAttempts: 3` ends `failed` with `attempts: 3`. `failAttempts: 2` completes on attempt 3.
- Validation rejects unknown fields, numeric strings, bad JSON, a missing Content-Type, and a bad Idempotency-Key, each naming the field.
- Replay returns 200, a changed payload returns 409, and routing returns 404 and 405 as specified.
- SIGKILL of the worker mid-job: the job was at 7/20, and after restart it completed on a second attempt about 2.5 seconds later.
- Health reports `worker: down` after a SIGKILL, then `up` after restart.

**Choices I made where the spec was open**

- A crash-recovered attempt counts toward `attempts`, so a job interrupted on attempt 3 would run as attempt 4 if it had no simulated failures left.
- The retry delay is a fixed 500 ms, which is within the allowed 250 ms–2 s.
- The browser UI was checked by reading the markup and the test IDs. I did not drive it in a real browser.

**Environment note:** Port 3917 was already held by a process I did not start. My first manual test run briefly hit that process instead of mine. I left it running and used a free port for the rest of the tests.