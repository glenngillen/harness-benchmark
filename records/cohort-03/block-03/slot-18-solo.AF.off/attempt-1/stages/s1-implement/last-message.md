I built the job tracker. `npm run build` succeeds, and both `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) pass.

**What I changed:**
- **`src/db.ts`**: opens the database and creates the tables if they don't exist: `jobs` (in submission order, with a unique idempotency key and the stored payload) and `heartbeat`. It also converts a database row into the job JSON shape.
- **`src/server.ts`**: all the API routes, `404 not_found` and `405 method_not_allowed`, and validation that lists every offending field. Saving a new job and checking its idempotency key happen in one database transaction, and the key is unique in the database, so a key never creates two jobs, even across restarts. `/health` reports the worker as `up` if its heartbeat is less than 3 seconds old. The server shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Writes a heartbeat every 500 ms.
  - Takes queued jobs oldest first, checking every 100 ms; each step takes 100 ms and progress is saved after each one.
  - A failed attempt goes back to `queued` and is retried after 500 ms. After 3 attempts the job is `failed` with `"transient failure"`.
  - While running a job, the worker holds a 3-second claim on it that it renews after each step. If the worker is killed with `SIGKILL`, the claim runs out and the job is picked up again within about 3 seconds of a restart.
  - On `SIGTERM` it puts its current job back in the queue, marks its heartbeat stale and exits.
- **`ui/index.html`**: the form, error region and job list with all the required `data-testid` attributes. It sends numeric fields as numbers, shows each rejected field's name, and refreshes the list every 500 ms.

I also tested by hand: after a `SIGKILL` of the worker during a 20-step job, the restarted worker finished it, and a `failAttempts: 3` job ended `failed` with 3 attempts. The non-JSON body, invalid `Idempotency-Key`, 405, 404 and health responses were all correct, and both processes exited cleanly on `SIGTERM`.

**Choices you might want to change:**
- **Attempt count after a crash:** an attempt cut off by a crash or shutdown still counts. The count stops at 3, so the final retry can still run.
- **Uncommitted:** the changes are saved in the working tree but not committed.