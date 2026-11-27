The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass.

**What changed**
- **`src/db.ts`**: opens the database in WAL mode, creates the `jobs` and `heartbeat` tables, and adds a `transaction` helper that takes the write lock up front.
- **`src/jobs.ts`** (new): job shape, SQL helpers, and the constants (3 attempts, 100 ms steps, 250–2000 ms retry delay, 3 s heartbeat staleness). Claiming the next job is a single atomic `UPDATE … RETURNING`.
- **`src/server.ts`**: routing with `404`/`405`, validation that collects every offending field, idempotency checked inside a transaction, and `/health` based on the worker heartbeat.
- **`src/worker.ts`**: requeues jobs left `running` at startup, writes a heartbeat every second, processes one job at a time, and handles simulated failures and retries.
- **`ui/index.html`**: the form, error region, and job list with all the required `data-testid` hooks. It polls every second and builds the DOM with `textContent`.

**Checks I ran beyond the fixed suites**
- Validation and idempotency edge cases return the specified status codes and field names.
- A job with `failAttempts: 5` ends `failed` after 3 attempts with `transient failure`.
- A job with `failAttempts: 2` completes on attempt 3.
- SIGKILL of the worker mid-job: after restart the job reprocesses and completes.
- Both processes exit cleanly on SIGTERM.

**Choices you may want to check**
- On startup the worker requeues every `running` job, so it assumes a single worker.
- A job in flight when the worker receives SIGTERM is requeued rather than left `running`. Its attempt counter still includes that attempt.
- A crashed attempt counts toward the 3-attempt limit like any other attempt.
- Body-level problems (wrong Content-Type, malformed JSON, non-object) are reported under the field name `body`. Bodies over 64 KB are rejected the same way.

**Something to know**
While testing, port 3917 was already held by a process I did not start, so my first server run failed with `EADDRINUSE`. I briefly sent requests to that process by mistake. I didn't touch it, and I reran everything on other ports. Its responses were not from this code, so none of this report depends on them.

Nothing is committed. The changes are in the working tree.