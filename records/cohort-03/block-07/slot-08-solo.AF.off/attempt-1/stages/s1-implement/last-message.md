The job tracker is built and works. `npm run build` succeeds, and both `check:smoke` (2/2) and `check:contract` (5/5) pass.

**What I changed** (only `src/` and `ui/`):
- **`src/db.ts`**: creates a `jobs` table and a `heartbeat` table in SQLite. Each idempotency key can belong to only one job, which the database enforces, so a key can't create a second job even across restarts.
- **`src/server.ts`**: implements all the endpoints in the task, including the request validation that reports every bad field, the error shapes, and 404/405 handling. The idempotency check and the job insert happen in one database transaction. `/health` reports the worker as `up` if its heartbeat is less than 3 seconds old. The server shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Writes a heartbeat every 500 ms and picks up the oldest queued job.
  - Each step takes 100 ms and progress is saved after every step.
  - A failed attempt goes back to `queued` and is retried after 500 ms. After 3 attempts the job becomes `failed` with `"transient failure"`.
  - On startup, any job left `running` goes back to the queue. On `SIGTERM`, the job in progress goes back to the queue before the worker exits.
- **`ui/index.html`**: the page has every required `data-testid` element and refreshes every 500 ms. The form has browser validation turned off and sends numbers as numbers, so the API does the validating. Rejections appear in the `role="alert"` region with each field's name.

**Tested by hand:** I checked retries running out on a `failAttempts: 3` job, the validation, 404/405 responses and `/health` going `down`. I also killed the worker with `SIGKILL` partway through a 20-step job. After restarting it, the job ran again and completed with `attempts: 2`.

**One choice to know about:** an attempt cut short by a crash counts toward `attempts`, because the task defines it as attempts started. Such a job is still reprocessed even if that takes it past 3 attempts.

**Not committed:** git has no user name or email set here, so the commit failed. The changes are staged, so you can commit them once git has an identity. The repo also has untracked files I didn't create (`.bashrc`, `.vscode`, `scripts`, …), which I left alone and didn't stage.