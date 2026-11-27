The job tracker is implemented in `src/` and `ui/`. `npm run build`, `check:smoke` (2/2) and `check:contract` (5/5) all pass. Changes are uncommitted in the working tree.

**What I changed**
- `src/db.ts`: schema for the `jobs` and `worker_heartbeat` tables, `rowToJob` mapping to the API shape, and `nowIso`.
- `src/server.ts`: routing, validation with per-field errors, 1 MB body cap, idempotent create in a `BEGIN IMMEDIATE` transaction, list/get, health, and the UI route. It shuts down on SIGTERM and SIGINT.
- `src/worker.ts`: heartbeat every second, requeue of jobs left `running` by a dead worker, a claim loop with `UPDATE … RETURNING`, progress after each step, retries via `run_after` (500 ms), and clean shutdown that requeues an interrupted job.
- `ui/index.html`: the form, form-error region, and job list with all required `data-testid` attributes. It polls every second and builds the DOM with `textContent` only.

**What I checked by hand** (live server and worker, separate processes)
- Every validation case in the task, plus the 404 and 405 JSON responses. Each rejected request created no job.
- Retries: `failAttempts: 2` completes on attempt 3. `failAttempts: 3` ends `failed` with `transient failure` and `attempts` 3.
- Idempotency: 201, then 200, then 409. The replay still returns 200 with the same id after a server restart.
- Progress rises 2 → 6 → 9 of 10 while running.
- Crash recovery: `kill -9` on the worker mid-run. Health reports `down` within 3.5 s. After a restart, the job completes with `attempts` 1.
- SIGTERM exits both processes with code 0.
- Startup with no env vars creates `data/jobs.db` and serves on port 3000.

**Choices where I went beyond or differed from the plan**
- Crash recovery decrements `attempts` for the interrupted attempt, because the attempt is redone. A job's `attempts` therefore never exceeds 3.
- A shutdown requeue during a job also undoes that attempt, for the same reason.
- The 405 response includes an `Allow` header.
- The forced-exit fallback after 3 s exits with code 1. A normal shutdown exits with 0.

**Not verified**
- I did not open the UI in a real browser. I checked that its script parses, that the testids are present, and that the API it calls behaves as specified.
- I left the untracked dotfiles in the repo root alone; they were there before I started.