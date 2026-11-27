The job tracker is built: an HTTP server, a separate worker process, and the browser page, all sharing state through SQLite. The build and all the fixed checks pass (smoke 2/2, contract 5/5). I couldn't commit, because git has no author identity set up here and I didn't want to change your git config. The changes are saved in `src/` and `ui/` but not committed.

**What I changed**
- **`src/db.ts`**: creates the `jobs` table and a one-row `heartbeat` table. Each job stores the `Idempotency-Key` (unique) and its payload with defaults applied. I also added a shared function that turns a database row into the job JSON shape.
- **`src/server.ts`**: all the API routes, plus 404 for unknown paths and 405 for wrong methods. Validation reports every bad field, using `"body"` when the body as a whole is the problem. A reused key returns 200 if the payload matches and 409 if it doesn't, and the unique key column means a key can never create two jobs. `/health` shows the worker as `up` if its heartbeat is less than 3 seconds old. `SIGTERM` shuts it down cleanly.
- **`src/worker.ts`**: writes a heartbeat every 500 ms and checks for queued jobs every 200 ms, oldest first. Each step takes 100 ms and progress is saved after each one. A failed attempt waits 500 ms in `queued` and is retried, up to 3 attempts in total; after that the job is `failed` with `"transient failure"`. On `SIGTERM` it puts any job it's in the middle of back in the queue and exits.
- **`ui/index.html`**: the form, error box and job list with all the required `data-testid` attributes. It refreshes every 0.7 s, and the number fields are sent as numbers.

**Tested by hand**
- I killed the worker with `SIGKILL` halfway through a 20-step job (at 9/20). After a restart the job finished as `completed`, with `attempts` still at 1.
- `failAttempts: 3` ends `failed` after 3 attempts.
- Unknown paths, wrong methods and a bad `Idempotency-Key` return the right errors.
- Both processes exit with code 0 on `SIGTERM`.

**Decision for you:** when the worker starts, it puts back in the queue any job left `running` by a worker that died, and re-runs that attempt without adding to `attempts`. That keeps a crash from using up one of the 3 retries, so a job can't fail just because the worker died. The catch is that `attempts` then doesn't count the attempt that was cut off. If you'd rather count it, it's a one-line change, but a job that crashes on its third attempt would then end `failed`.

This recovery assumes one worker at a time. Two workers running at once could each requeue the other's jobs.