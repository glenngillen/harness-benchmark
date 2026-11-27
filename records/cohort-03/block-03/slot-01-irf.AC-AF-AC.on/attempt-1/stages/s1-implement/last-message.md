Everything is implemented and verified. `npm run build` exits 0, both check suites pass (smoke 2/2, contract 5/5), and the manual checks below pass too. I have not committed anything.

**What changed**
- `src/db.ts`: opens the database, creates the `jobs` and `heartbeats` tables if missing, and sets WAL mode with a busy timeout.
- `src/jobs.ts`: the job row type and the mapping to the public JSON shape.
- `src/server.ts`: the HTTP API (`/health`, `/api/jobs` POST/GET, `/api/jobs/:id`, `/`), validation, idempotency, and 404/405 routing. Creation runs in an IMMEDIATE transaction. `/health` reports `worker: up` only if the worker's heartbeat is under 3 seconds old.
- `src/worker.ts`: claims the oldest runnable queued job, runs 100 ms steps with progress written after each step, and handles retries. A failing attempt is requeued after 500 ms, and the third failure marks the job failed with `transient failure`. On startup it requeues any job left `running`. It writes a heartbeat every second and deletes it on clean shutdown.
- `ui/index.html`: the form and job list with the required `data-testid` attributes, polling every second.

**Manual checks**
- `failAttempts: 3` ends `failed` with `attempts: 3`. `failAttempts: 2` completes on attempt 3.
- Validation rejects the bad inputs I tried, with the offending field named. Unknown routes return 404 and wrong methods return 405.
- An idempotency key replays with 200 and conflicts with 409.
- After SIGKILL of both processes and a restart, existing jobs and their status are still there.
- Health reports `worker: down` after the worker is stopped.

**Choices and limits**
- The worker's startup requeue assumes a single worker. Two concurrent workers would wrongly requeue each other's running jobs.
- On SIGTERM mid-job, the job stays `running` and is requeued on the next worker start.
- `fields` is also included on errors with a `body` or `Idempotency-Key` problem, using the names `"body"` and `"Idempotency-Key"`.

**Something to look at**
My first manual run used port 3917. My server failed with `EADDRINUSE` because another process was already listening there. Responses from 3917 were not from my code, so I discarded them and reran everything on port 4817 with a fresh database. I could not see which process held 3917 because the sandbox hides PIDs. If you see a stray server on that port, it is not part of this work.