The job tracker is built and working. `npm run build` succeeds, and both provided check suites pass (smoke 2/2, contract 5/5). I haven't committed anything.

**What I changed:**
- **`src/db.ts`**: opens the shared SQLite database and creates the tables if they don't exist: one for jobs and one for the worker's heartbeat. It also converts stored rows into the job JSON shape.
- **`src/server.ts`**: the full HTTP API. Validation lists every offending field, using `"body"` for whole-body problems and `"Idempotency-Key"` for a bad key. Idempotency compares the payload after defaults are applied, and a database uniqueness rule keeps one key to one job, even across restarts. Unknown paths return 404 and wrong methods 405. `/health` reports the worker as "up" only if its heartbeat is under 3 seconds old. The server shuts down cleanly on SIGTERM.
- **`src/worker.ts`**: writes a heartbeat every second and checks for queued jobs every 100 ms, oldest first. Each step takes 100 ms and progress is saved after every step. Failed attempts go back to the queue for 500 ms, and the third failure marks the job failed with "transient failure". On startup it re-queues any job left "running" by a crashed worker. On SIGTERM it stops after the current step, puts that job back in the queue and exits.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. It refreshes every 0.7 s and updates existing items in place. API rejections, including each field name, appear in the `form-error` region. Browser-side validation is turned off so invalid values reach the API.

**Manual testing beyond the provided checks:**
- A job with `failAttempts: 3` ended `failed` with 3 attempts.
- I killed the worker with SIGKILL partway through a 20-step job. Health switched to "down", and after a restart the job completed.
- Malformed JSON, a non-object body, whitespace-only input, a non-integer `steps`, a missing `Content-Type` and a bad idempotency key each got a 400 naming the right field. A wrong method got 405 and an unknown path 404.
- Both processes exited cleanly on SIGTERM.

**Behaviour you might not expect:**
- When a job is interrupted (by a crash or a SIGTERM), the next run counts as a new attempt, so `attempts` goes up. In the SIGKILL test the job finished with `attempts: 2`.
- If the interrupted run was already the third attempt, it is re-run as attempt 3 rather than going over the limit. The spec doesn't say what to do in that case, so this was my choice.
- Besides `application/json`, the server also accepts `+json` content types such as `application/vnd.api+json`.