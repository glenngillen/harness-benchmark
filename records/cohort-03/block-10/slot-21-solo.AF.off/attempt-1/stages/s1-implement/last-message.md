The job tracker is built: a clean `npm run build`, and `check:smoke` (2/2) and `check:contract` (5/5) both pass. I also ran a manual end-to-end test. Invalid requests, wrong methods and unknown paths returned the right error codes. A job with `failAttempts: 3` ended `failed` with `attempts: 3`. After I killed the worker with `SIGKILL` partway through a 20-step job and restarted it, the job finished. Both processes exited cleanly on `SIGTERM`. I haven't opened the page in a browser, so the UI is untested, and nothing is committed.

**What changed**
- **`src/db.ts`**: creates the parent directory, sets SQLite to wait up to 5 seconds when the other process holds a lock, and creates the tables on startup. There's a `jobs` table (the idempotency key is a unique column, so a key can never create two jobs, even across restarts) and a one-row `heartbeat` table.
- **`src/server.ts`**: all the API routes, validation that lists every bad field, and idempotency (the payload is compared after defaults are filled in). Creating a job runs inside a locked transaction. `/health` reports the worker as up if its heartbeat is under 3 seconds old. It shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Writes a heartbeat every 500 ms and picks up the oldest ready job about every 100 ms.
  - Each step takes 100 ms and saves progress as it goes.
  - A failed attempt goes back to `queued` and is retried 500 ms later. After the third failure the job becomes `failed` with `"transient failure"`.
  - On `SIGTERM` it puts the current job back in the queue.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. It refreshes every 500 ms without reloading the page, sends the number fields as numbers, and shows API rejections in the `form-error` alert with each field's name. The form skips browser validation so the API's rules apply.

**Decisions worth knowing about**
- **Interrupted jobs keep their attempt number.** When the worker restarts, any job still marked `running` is redone without increasing `attempts`, so a crash doesn't use up one of the 3 tries. A job may show `running` again with the same count.
- **The worker assumes it's the only one.** On startup it requeues every `running` job, which would be wrong if two workers ran against the same database. The task only calls for one.

I ignored the unrelated dotfiles in the repo root (`.env*`, `.mcp.json` and so on).