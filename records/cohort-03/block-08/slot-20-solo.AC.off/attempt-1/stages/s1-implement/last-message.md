The job tracker is implemented in `src/` and `ui/`, and it builds. Both check suites pass: smoke 2/2 and contract 5/5. I also ran the server and worker by hand on their own ports and exercised the behaviour the fixed checks don't cover.

**What I changed**
- **`src/db.ts`**: opens SQLite in WAL mode, creates the schema (`jobs`, `idempotency_keys`, `worker_heartbeat`), and provides a `transaction()` helper.
- **`src/jobs.ts`** (new): validation, the job JSON shape, and job submission with idempotency. The idempotency check and the insert run in one transaction.
- **`src/server.ts`**: the HTTP API, `/health`, and `GET /`. Wrong methods return 405, unknown paths return 404, and invalid input returns 400 with `fields`. Shutdown on SIGTERM is clean.
- **`src/worker.ts`**: claims the oldest due job, runs steps of 100 ms with per-step progress writes, and handles retries. Retries wait 500 ms, and the third failed attempt marks the job `failed`. It writes a heartbeat every second and deletes it on clean shutdown. On startup it requeues any job left `running`.
- **`ui/index.html`**: the form and job list with every required `data-testid`. It polls every 500 ms and builds the DOM with `textContent` only.

**Verified by hand**
- `failAttempts: 3` ends `failed` with `attempts: 3`. `failAttempts: 2` completes on attempt 3.
- A repeated idempotency key returns 200 with the same job. A different payload with the same key returns 409.
- A worker SIGKILLed mid-job (`running`, 6/20) completes after restart with `attempts: 2`.
- Health goes `down` about 3 s after a worker is SIGKILLed, and back to `up` after restart.
- Jobs survive a server SIGKILL.
- The page script passes `node --check`. I did not exercise the page in a real browser.

**Choices I made**
- A crash-interrupted attempt still counts toward `attempts`. The retry cap of 3 applies to failed attempts. Crash-interrupted attempts are always reprocessed.
- A failing attempt waits one step (100 ms) before failing, so `running` is briefly visible.
- Only one worker is supported. Startup requeues every `running` job, which would be wrong if two workers ran at once.
- Bodies over 64 KB get `400` with field `body`. The spec does not cover this case.

**Things to know**
- During my first manual run, port 3917 was already held by a process I can't see, so my server failed to bind. I discarded that run's output and reran on port 4823. I did not touch the other process.
- `git status` shows untracked dotfiles (`.bashrc`, `.zshrc`, `.gitconfig`, and others) plus `scripts/` and `.idea/`. I did not create these. I did not add or commit them.
- I have not committed anything, since you didn't ask for a commit.