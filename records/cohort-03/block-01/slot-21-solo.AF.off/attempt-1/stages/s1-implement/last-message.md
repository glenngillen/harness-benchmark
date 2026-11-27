The job tracker is built. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I also ran a manual test: invalid requests got the right error codes, a job left running when I killed the worker with `SIGKILL` was picked up and finished after a restart, and both processes stopped cleanly on `SIGTERM`. I haven't checked the browser page in a real browser.

**What I changed:**
- **`src/db.ts`**: creates the `jobs` table and a `heartbeat` table, and converts database rows into the job JSON shape the task specifies.
- **`src/server.ts`**:
  - All the API routes, with 404 for unknown paths and 405 for wrong methods.
  - Full validation. Every bad field is listed in `fields`, and `"body"` is used for content-type, JSON and non-object problems.
  - Idempotency keys are stored with a unique constraint, so a key creates at most one job even after a restart. Payloads are compared after defaults are applied.
  - `/health` reports `"up"` if the worker's heartbeat is less than 3 seconds old.
- **`src/worker.ts`**:
  - Writes a heartbeat every second and checks for queued jobs every 150 ms, oldest first.
  - Each step takes 100 ms, and progress is saved to the database after every step.
  - A failed attempt is retried after 500 ms. After the third failure the job is `failed` with error `"transient failure"`.
  - Updates only apply to jobs that are still `running`, so completed and failed jobs are never touched again.
- **`ui/index.html`**: has every required `data-testid` element. Number fields are sent as numbers, and browser-side checks are off so the API's own validation applies. The `form-error` region lists each rejected field by name. The job list refreshes every second.

**One choice you may want to change:** if the worker dies mid-attempt, it lowers `attempts` by one at startup and runs that attempt again. A crash therefore never uses up one of the 3 allowed attempts, and a job that was succeeding on its last attempt isn't failed because of it. The downside is that `attempts` doesn't count interrupted attempts. A graceful `SIGTERM` handles an in-progress job the same way.

Nothing is committed. `git status` shows some untracked dotfiles (`.bashrc`, `.vscode`, `scripts`, and others) that I didn't create; they appear to come from the sandbox's file mounts, and I left them alone.