The job tracker is built: the build exits 0, the smoke suite passes 2/2, and the contract suite passes 5/5. I also ran a 34-check end-to-end script covering the parts the fixed suites don't reach, and all of it passes.

Changes (only under `src/` and `ui/`; nothing committed):

- **`src/db.ts`**: shared schema for `jobs` and `heartbeats`, and a mapper from rows to the public job shape.
- **`src/server.ts`**: routing with 404/405, validation with per-field errors, idempotency checked and inserted inside one `BEGIN IMMEDIATE` transaction, and `/health` reporting the worker from a heartbeat under 3 s old. It shuts down on SIGTERM and SIGINT.
- **`src/worker.ts`**: writes a heartbeat every second and claims the oldest runnable job. Each step updates progress and renews a lease, and writes are guarded by attempt number. Simulated failures retry after 500 ms, up to 3 attempts.
- **`ui/index.html`**: the form and job list with all the required `data-testid` hooks. It polls every second, shows API rejections with field names in `form-error`, and renders text with `textContent`.

Choices I made:
- **Crash recovery uses a 2 s lease rather than resetting `running` jobs at startup.** A killed worker's job is reclaimed about 2 s after it stops renewing, so a restart resumes it well inside the 10 s window and a second worker can't clobber a live one.
- **A reclaimed job counts the crashed attempt in `attempts`.**
- **A graceful SIGTERM mid-job doesn't requeue the job.** It waits for the lease to lapse, the same as a crash.
- **Request bodies over 64 KB are rejected** as an invalid body.
- **The form omits empty `steps` and `failAttempts` fields** so the API defaults apply.

Things to check:
- `git status` shows untracked files I did not create: `.bashrc`, `.gitconfig`, `.github`, `.idea`, `.vscode`, `scripts`, and others. The repo was clean at the start, so something outside this work added them. I left them alone.
- During testing, port 3917 was already held by a process outside this repo that returned a different error message. I moved my tests to a random port.