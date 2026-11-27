The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass. I did not commit; the changes are in the working tree.

**What changed**
- `src/db.ts`: creates the schema on open (`jobs`, `heartbeats`). Keeps the WAL and busy-timeout setup.
- `src/jobs.ts` (new): validation, the job JSON shape, idempotent submit (one `BEGIN IMMEDIATE` transaction), and the worker's claim, progress, complete, retry, fail, and heartbeat operations.
- `src/server.ts`: routing, 404/405 handling, body and Content-Type checks, `Idempotency-Key` handling, `/health` (worker is `up` if its heartbeat is under 3 s old), and clean SIGTERM/SIGINT shutdown.
- `src/worker.ts`: claims the oldest due job, runs 20 steps at ~100 ms each with progress written after every step, and applies the retry rules. It writes a heartbeat every second and requeues interrupted work on startup and on shutdown.
- `ui/index.html`: the form and job list with every required `data-testid`. It polls `/api/jobs` every second and shows API rejections, including field names, in `form-error`.

**Manual checks beyond the fixed suites**
- Validation, 409 and 200 idempotency replays, 404 and 405 responses: all as specified.
- `failAttempts: 3` ends `failed` with `attempts: 3`. `failAttempts: 2` completes on attempt 3.
- SIGKILL of the worker mid-job: `worker` reads `down` in `/health`. After restart the job is reprocessed and completes, and it survives a server SIGKILL and restart.
- SIGTERM on the worker exits in about 160 ms.
- I did not drive the browser UI; I only checked that `/` serves the required test ids.

**Choices I made where the spec was open**
- A crashed or stopped attempt is not counted. The job is requeued with `attempts` decremented, so the re-run keeps the same attempt number and the 3-attempt limit holds. The spec's "attempts = attempts started" could be read the other way.
- Retry delay is a fixed 500 ms.
- Body larger than 1 MB is rejected as an invalid `body` field.
- The UI sends empty `steps` or `failAttempts` fields omitted, so the API defaults apply.