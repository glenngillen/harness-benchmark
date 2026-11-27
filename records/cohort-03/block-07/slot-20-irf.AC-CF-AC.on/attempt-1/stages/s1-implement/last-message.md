The job tracker is built: the server and worker run as separate processes sharing SQLite, and both fixed contract checks pass. `npm run build` is clean, and `check:smoke` (2/2) and `check:contract` (5/5) pass. I haven't committed anything.

**What I changed**
- `src/db.ts`: opens SQLite in WAL mode with `synchronous = FULL` and creates the schema (`jobs`, `worker_heartbeat`).
- `src/jobs.ts` (new): job persistence, claiming the oldest due job, progress, completion and failure, and the heartbeat.
- `src/validation.ts` (new): request validation. It reports every offending field, using `body` when the body as a whole is the problem.
- `src/server.ts`: routing, `/health`, job creation with idempotency, 404/405 handling, and clean `SIGTERM`/`SIGINT` shutdown.
- `src/worker.ts`: crash recovery on start, a poll loop, 100 ms steps with per-step progress writes, retries, and a heartbeat every second.
- `ui/index.html`: the form and job list with all the required `data-testid` elements. It polls every second and builds the list with `textContent`, not HTML strings.

**Choices I made**
- Retry delay is a fixed 1 s.
- A worker that dies during its last allowed attempt marks the job `failed` with `transient failure` on restart, rather than running a fourth attempt.
- A worker stopped gracefully mid-attempt puts the job back in the queue. That attempt still counts toward `attempts`.
- The design assumes one worker process.

**Verified by hand** (a scratch run on a separate port): exhausted retries end `failed`, `failAttempts: 2` completes on attempt 3, and an idempotent replay returns 200 with 409 on a changed payload. Validation, 404/405 routing, and `/health` going `down` within about 3 s of a `SIGKILL` all behave as specified. After a restart with the same database, jobs and idempotency keys survive, and an interrupted job runs to completion.

**Not verified**
- I haven't tested the page in a real browser. The UI script passes a syntax check, and the test IDs are present.
- During my first manual run, port 3917 was already held by another process, which answered instead of my server. I reran on a different port, and the results above are from that run.