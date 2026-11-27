The job tracker works: it builds cleanly, and the smoke checks (2/2) and contract checks (5/5) pass.

**What I changed**
- **`src/db.ts`**: opens the database, creates the parent folder if it's missing, and sets up two tables: `jobs` and a single-row `heartbeat`. It also converts a database row into the job JSON shape from the task.
- **`src/server.ts`**: implements every endpoint, with full validation that lists each bad field and the error shapes for 400, 404, 405 and 409.
  - **Idempotency:** the key and the payload (after defaults) are stored with the job, and the key column is unique in the database. A key can only ever create one job, even across restarts.
  - **`/health`:** reports the worker as `up` only if its heartbeat is less than 3 seconds old.
  - **Shutdown:** stops cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Writes a heartbeat every second.
  - Claims the oldest queued job that is due, in a single database update, and runs 100 ms steps, saving progress after each one.
  - On a failed attempt it requeues the job after 500 ms, and after the third failure marks it `failed` with "transient failure".
  - On `SIGTERM` it puts the current job back in the queue and clears its heartbeat, so `/health` shows `down` straight away.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. Numeric fields are sent as numbers, and the form skips browser validation so the API's rules apply. API rejections, including each field's name, appear in the `role="alert"` region, and the list refreshes every 500 ms.

**One behaviour you might not expect:** when the worker restarts and finds a job still `running` (a crash or `SIGTERM` mid-job), it re-runs that attempt instead of counting a new one. It does this by lowering `attempts` by one before requeueing. This keeps the outcome predictable (`failAttempts: 2` still completes on attempt 3) and `attempts` never goes above 3, but a crashed attempt won't show in the count.

**Manual tests I ran:**
- **Crash recovery:** I killed the worker with `SIGKILL` halfway through a 20-step job, and after a restart it completed with `LONG JOB`.
- **Final failure:** a job with `failAttempts: 3` ended `failed` with `attempts: 3`.
- **Errors:** I sent a wrong Content-Type, a bad Idempotency-Key, a non-object body, whitespace-only input, a non-integer `steps`, a wrong method and an unknown path, and each got the right error response.

I haven't committed anything. Some untracked files I didn't create also appeared in the workspace (`.bashrc`, `.zshrc`, `.gitconfig`, `.mcp.json`, `.github/`, `.vscode/`, `scripts/` and others). I left them alone; you may want to check where they came from before committing.