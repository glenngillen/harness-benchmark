The job tracker is implemented in `src/` and `ui/`. It builds, and all 7 fixed checks pass (`check:smoke` 2/2, `check:contract` 5/5). I also ran the server and worker by hand for the cases the fixed checks don't cover, and they behaved as specified. Nothing is committed.

**What I changed**
- `src/db.ts`: opens SQLite in WAL mode with a busy timeout, creates the `jobs` and `heartbeat` tables, and adds a write-locked `transaction` helper.
- `src/jobs.ts` (new): job storage and state transitions. Idempotency is checked and inserted in one transaction, and a UNIQUE column backs it up across restarts.
- `src/validation.ts` (new): request validation. It reports every offending field and enforces the JSON content type, the body shape, and the `Idempotency-Key` format.
- `src/server.ts`: all routes, including the 404 and 405 cases, plus `/health` with worker liveness from the heartbeat. It shuts down cleanly on SIGTERM.
- `src/worker.ts`: claims the oldest ready job, processes steps at 100 ms each, and writes progress after every step. It retries transient failures with a 500 ms delay, writes a heartbeat every second, and recovers interrupted jobs at startup.
- `ui/index.html`: the form and job list with all required `data-testid` attributes. It polls every second.

**Checks I ran by hand**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- Idempotency replay returns 200, a different payload returns 409, and a bad key returns 400.
- Validation, malformed JSON, the Content-Type check, 404, and 405 all return the specified responses.
- After SIGKILL of both processes, a restart picks up the running job, which then completes. `/health` reports `worker: "up"`.
- After a graceful worker stop, `/health` reports `"down"` immediately.

**Choices you may want to review**
- **Interrupted attempts are rolled back.** When a worker dies mid-attempt, the attempt is not counted, so `attempts` stays within the 3-attempt budget. The spec could also be read as "a crashed attempt still counts", which would give a different `attempts` value after a crash. This is the main judgment call.
- **Recovery runs at every worker start**, so the design assumes a single worker. A second concurrent worker would wrongly requeue the first one's running job.
- **Retry delay is a fixed 500 ms**, and each step takes 100 ms.
- **Oversized bodies** (over 16 KB) return `400 invalid_request` with field `body`. The spec doesn't cover this case.
- **Untracked dotfiles at the repo root** (`.bashrc`, `.zshrc`, `.github`, and others) were already in the working directory and are not from my changes. I left them alone.