The job tracker is built, and both fixed check suites pass (smoke 2/2, contract 5/5). I also exercised behavior the checks don't cover, against a scratch database.

**What I changed**
- `src/db.ts`: opens SQLite in WAL mode with `synchronous = FULL` and creates the schema: a `jobs` table, a `heartbeats` table, and a queue index.
- `src/jobs.ts` (new): shared constants (100 ms steps, 500 ms retry delay, 3 attempts), the `Job` type, and the row-to-API mapping.
- `src/validation.ts` (new): body and `Idempotency-Key` validation. Every offending field is collected into `fields`.
- `src/server.ts`: routing (404/405 with an `Allow` header), body parsing with a 64 KiB limit, and idempotent job creation inside `BEGIN IMMEDIATE`. The health endpoint reads the worker's heartbeat.
- `src/worker.ts`: claims the oldest eligible queued job, runs the steps while updating progress, and handles simulated failures and retries. It writes a heartbeat every second and requeues jobs left `running` at startup. It shuts down on SIGTERM.
- `ui/index.html`: the form and job list with every required `data-testid`. It polls `/api/jobs` every second.

**Verified**
- Both checks suites pass after the final build.
- A job with `failAttempts: 3` ends `failed` with `attempts: 3`. A job with `failAttempts: 2` completes on attempt 3.
- SIGKILL of both processes mid-job: after restart the job resumed and completed with `SURVIVE ME`. A keyed replay after restart returned 200.
- Health reports `worker: down` after the worker is SIGKILLed.
- Invalid bodies, bad Content-Type, malformed JSON, 404, and 405 all return the documented shapes.

**Choices I made where the spec was open**
- Missing or non-JSON Content-Type is reported under field `"body"`.
- An unknown field is reported under its own name.
- A job that was `running` when the worker died keeps the interrupted attempt in its `attempts` count, so a recovered job can show `attempts: 2` or more.
- The worker waits 100 ms before a simulated failure, then requeues with a 500 ms delay.

**Not verified**
- The UI's behavior in a real browser. I checked the markup and the script by reading them, not by running them.

**Untracked files I did not create**
- `git status` shows dotfiles and directories (`.bashrc`, `.github`, `.vscode`, `scripts/`, and others) that were not in the clean status at the start. I left them alone.