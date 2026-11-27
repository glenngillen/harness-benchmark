The job tracker is built and both check suites pass: smoke 2/2 and contract 5/5. I also tested the parts the checks don't cover, by hand against a fresh database.

**What I changed**
- **`src/db.ts`**: opens SQLite with WAL and a busy timeout, and creates the `jobs` and `heartbeats` tables if they are missing.
- **`src/jobs.ts`** (new): the job row shape, the JSON mapping, and the queries both processes use. Claiming a job and recording an attempt happen in one `BEGIN IMMEDIATE` transaction.
- **`src/server.ts`**: the HTTP API.
  - Validation collects every offending field and returns them in `fields`.
  - Idempotency is keyed in the database, so it survives restarts.
  - Routing returns 404 and 405 as specified.
  - `/health` reports the worker as `up` when its heartbeat is less than 3 seconds old.
- **`src/worker.ts`**: the worker.
  - It writes a heartbeat every second.
  - On startup it requeues any job left `running` by a dead worker.
  - It processes jobs oldest first, with 100 ms steps and progress written after each step.
  - Failed attempts requeue with a 500 ms delay, and the job is marked `failed` after the third attempt.
- **`ui/index.html`**: the form and job list with all the required `data-testid` hooks. It polls every second and builds the DOM with `textContent`, so job input is never treated as HTML.

**Choices I made**
- The retry delay is a fixed 500 ms.
- On a graceful stop, a job mid-attempt stays `running` and is requeued on the next start.
- The request body is capped at 16 KiB.
- The UI sends a numeric-looking `steps` or `failAttempts` as a number, and sends anything else as typed so the API rejects it.
- I did not commit anything. The working tree has my changes to the four files above plus the new `src/jobs.ts`.

**Verified by hand**
- A job with `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- Idempotent replay returns 200, and a different payload under the same key returns 409.
- Invalid bodies return 400 and name the fields.
- Unknown routes return 404, and wrong methods return 405.
- SIGKILL on the worker mid-job, then a restart: the job resumed, completed, and the idempotency key still replayed the same job.
- SIGTERM exits both processes cleanly.

**Things to know**
- My first manual test run was broken (the backgrounded shell chain never set my variables), and a `pkill -f` pattern I used may have signalled other processes matching `dist/(server|worker).js`. I didn't check what, if anything, it hit.
- The repo root has untracked files I did not create: dotfiles like `.bashrc`, plus `.github/`, `.idea/`, `.vscode/`, and `scripts/`. I left them alone.