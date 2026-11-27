The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I did not commit anything.

**What changed**
- **`src/db.ts`**: opens the shared SQLite file in WAL mode and creates the `jobs` and `heartbeat` tables. It also holds the `Job` type, the row-to-JSON mapping, and the heartbeat helpers.
- **`src/server.ts`**: a `node:http` router with strict validation, idempotency enforced in a `BEGIN IMMEDIATE` transaction, JSON errors on every path, and SIGTERM handling.
- **`src/worker.ts`**: recovers interrupted jobs at startup, claims the oldest eligible queued job, runs the steps with progress written after each one, applies retries, writes a heartbeat every 500 ms, and exits on SIGTERM.
- **`ui/index.html`**: the form, the `form-error` alert region and the job list with all the required `data-testid`s. It polls `/api/jobs` every second and builds the DOM with `textContent`.

**Choices I made where the spec was open**
- **Crash recovery rolls back the interrupted attempt.** A `running` job goes back to `queued` with its `attempts` decremented, so the re-run keeps the same attempt number. This keeps `attempts` at most 3 and makes `failAttempts` deterministic. The alternative reading, where the killed attempt still counts, would give `attempts` a value above 3 in some cases.
- **Transient DB errors in the worker are logged and retried**, not fatal.
- **Oversized bodies (over 1 MB)** return 400 with field `body`.

**Verified by hand** (scratch database in `$TMPDIR`)
- Every validation case in the plan returns 400 with the right `fields`, and no job is created.
- Idempotency returns 201, then 200 on replay, then 409 on a changed payload. Replay and conflict also work after a SIGKILL restart.
- Progress rises 1..10 and the output matches `toUpperCase()`, including `ßtraße` → `SSTRASSE`.
- `failAttempts: 2` ends `completed` with `attempts: 3`. `failAttempts: 3` ends `failed` with `attempts: 3`.
- Crash recovery: a worker killed at 4/20 is restarted and completes at 20/20 with the same id. A job that was already complete keeps its `updatedAt`.
- Durability: after SIGKILL of both processes, all jobs are still listed.
- Routing: `DELETE /api/jobs` and `POST /health` return 405 with an `Allow` header. Unknown paths return 404. All are JSON.
- SIGTERM: the server exits in 6 ms and the worker in 102 ms.
- Health: `worker` goes `up` when the worker runs and `down` 3.2 s after a worker SIGKILL.

**Not verified**
- I did not run the UI in a real browser. I checked that the `data-testid`s are present and that the inline script parses. The live-update and form-error behaviour is untested in a browser.