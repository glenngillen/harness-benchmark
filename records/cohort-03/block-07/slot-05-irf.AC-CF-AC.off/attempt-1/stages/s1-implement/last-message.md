The job tracker is implemented in `src/` and `ui/`, and `npm run build`, `check:smoke` (2/2) and `check:contract` (5/5) all pass. Nothing is committed.

**What changed**
- **`src/db.ts`**: keeps `openDatabase` and adds an idempotent schema: a `jobs` table and a one-row `worker_heartbeat` table.
- **`src/jobs.ts`** (new): job persistence. Idempotent submit runs in a `BEGIN IMMEDIATE` transaction, so a key can't create two jobs. It also has claim, progress, complete, fail and requeue helpers, plus crash recovery and the heartbeat.
- **`src/validation.ts`** (new): validates the body and reports every offending field. Defaults are applied before the idempotency fingerprint is computed.
- **`src/server.ts`**: routes, the error shapes, and the 400/404/405/409 cases. `/health` reports the worker as `up` if its heartbeat is at most 3 s old. SIGTERM closes the database and exits.
- **`src/worker.ts`**: polls every 200 ms for the oldest due job, runs 100 ms steps, and writes progress after each step. It writes a heartbeat every second and clears it on SIGTERM. Retries wait a random 250–2000 ms.
- **`ui/index.html`**: the form and job list with all the required `data-testid`s. It polls every second and renders job data with `textContent`, so input is never treated as HTML.

**Choices I made where the spec was open**
- **Crash recovery**: a job found `running` at worker start goes back to `queued`, and the interrupted attempt still counts. If the crash happened on attempt 3, the counter is rolled back by one, so attempt 3 is re-run and the 3-attempt cap holds.
- **Graceful shutdown**: the worker exits at once and does not requeue an in-flight job. The next worker start recovers it.
- **Retry delay**: random between 250 and 2000 ms.
- **Body size**: capped at 16 KB; larger bodies get a `400` with field `body`.

**Verification**
- A behaviour test in `$TMPDIR` (outside the repo) passes. It covers validation, defaults, completion, retries, a job that ends `failed`, idempotent replay and conflict, routing errors, SIGKILL recovery with no reprocessing of completed jobs, heartbeat going down on SIGTERM, and clean exits.
- I checked that `/` serves every required `data-testid`. I did not test the page in a real browser, so the rendering and polling are unverified.
- My first test run used port 3917, which another process was already using. Its responses did not come from this code, so I discarded those results and reran on a free port.

I did not touch `.bashrc`, `.gitconfig` and the other untracked dotfiles, which were already present in the working tree.