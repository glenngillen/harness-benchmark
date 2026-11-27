The job tracker is implemented in `src/` and `ui/`. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What changed**
- **`src/db.ts`**: Creates the schema (`jobs` and `meta` tables) on open, and adds the job row-to-JSON mapping and a `BEGIN IMMEDIATE` transaction helper.
- **`src/server.ts`**: Routing (404 and 405 handling), validation that collects every offending field, idempotency with the key stored in SQLite, and `/health` based on a worker heartbeat no older than 3 s. Shuts down on SIGTERM.
- **`src/worker.ts`**: Claims queued jobs oldest first and runs 100 ms steps, writing progress after each one. Failed attempts go back to `queued` with a 250–1999 ms delay, and the third failure marks the job `failed`. Writes a heartbeat about once a second, and on startup requeues jobs left `running` by a dead worker.
- **`ui/index.html`**: The form and job list with the required `data-testid` attributes, polling every second.

**Choices I made**
- **Interrupted attempts:** A job killed mid-attempt keeps the attempt counted and runs again as the next attempt. The exception is when the killed attempt was the third, which is re-run as attempt 3 so the total never exceeds three.
- **Heartbeat on shutdown:** The worker zeroes its heartbeat on clean exit, so `/health` reports `down` straight away.
- **Unknown fields:** Reported under the field's own name, for example `colour`.
- **Body size:** Bodies over 64 KB are rejected with `invalid_request` on field `body`. The spec doesn't cover this.

**Verified by hand**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- After a worker is killed with SIGKILL mid-job, the restarted worker finishes the job with `attempts: 2`, and `/health` reports `worker: down` while the worker is dead.
- The idempotent replay returns 200 after a restart, and a 404 and a 405 return the expected codes.
- The validation edge cases return 400 with the right field names.

**Not verified:** I did not open the UI in a browser. I only checked that its script parses.

**Environment note:** Port 3917 was already in use by a process I don't control. My first manual run briefly got responses from it, so I discarded that run and reran on a verified-free port. The untracked dotfiles and `scripts/`, `.github/`, `.idea/`, `.vscode/` in the working tree were already there and I left them alone.