The job tracker is implemented. `npm run build` is clean, and both fixed suites pass: smoke 2/2 and contract 5/5. I also ran the server and worker by hand on a fresh database and checked the edge cases below.

**What I changed** (`src/db.ts`, `src/server.ts`, `src/worker.ts`, `ui/index.html`, plus new `src/jobs.ts` and `src/validate.ts`):
- **Database:** `jobs` and `meta` tables in WAL mode with a busy timeout. Writes run in `BEGIN IMMEDIATE` transactions. A unique partial index on `idempotency_key` enforces one job per key, including across restarts.
- **Server:** all routes, validation with per-field errors, idempotent create (201 new, 200 replay, 409 conflict), and `/health`. Worker liveness comes from a heartbeat row written by the worker every second; the server reports `up` if it is under 3 seconds old.
- **Worker:** claims the oldest available queued job, runs 100 ms steps with progress written after each step, and applies simulated failures and retries. On startup it requeues any job left `running` by a previous crash.
- **UI:** a form with the required `data-testid`s, polling `/api/jobs` every second. Rejections show the message and each offending field.

**What I verified by hand:**
- Validation: wrong types, numeric strings, out-of-range values, unknown fields, malformed JSON, non-object bodies, and missing content type all return 400 with the right field.
- Routing: unknown paths return 404 and wrong methods return 405.
- Idempotency: same payload gives 200, different payload gives 409.
- Retries: `failAttempts: 2` completes on attempt 3, and `failAttempts: 3` ends `failed` with `attempts: 3`.
- Restart: a worker killed with SIGKILL mid-job resumed and completed the job after restart.
- Shutdown: SIGTERM stops both processes cleanly.

**Choices I made:**
- A crash-interrupted attempt still counts toward `attempts`, since the spec defines it as attempts started.
- Retry delay is a fixed 500 ms.
- A missing or non-JSON Content-Type is reported under field `body`.
- The worker assumes a single instance. Two workers running at once could requeue each other's in-flight job.

**Things to know:**
- During my first manual run, port 3917 was already held by a process I could not see, so the server failed to start and some of my requests hit that other process. I reran on a free port with an isolated database, and those are the results above. I did not touch the other process.
- I did not commit anything. The working tree also has several untracked dotfiles and directories (`.bashrc`, `.github`, `.idea`, `scripts`, and others) that I did not create. Please exclude them if you commit.