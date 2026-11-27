The job tracker is implemented. `npm run build` is clean, and both fixed check suites pass (smoke 2/2, contract 5/5). The hidden evaluation may still cover cases the checks don't.

**Changed files** (no commits made):
- `src/db.ts`: kept `openDatabase`, added `initSchema` (the `jobs` and `worker_heartbeat` tables, idempotent), `rowToJob`, and `nowIso`.
- `src/server.ts`: `node:http` server with routing, validation that collects every field error, idempotency via a canonical payload and a UNIQUE key column, health from the heartbeat, JSON 404/405/500 responses, serving `ui/index.html`, and SIGTERM shutdown.
- `src/worker.ts`: heartbeat every 500 ms, startup recovery, a claim loop in `BEGIN IMMEDIATE`, 100 ms steps with progress written after each, retries with a 500 ms delay capped at 3 attempts, and clean SIGTERM handling.
- `ui/index.html`: the form and job list with every required `data-testid`, polling every second, and `textContent` throughout.

**Choices I made where the spec was open:**
- Recovery of an interrupted `running` job decrements `attempts` so the redo keeps the same attempt number. A worker stopped by SIGTERM mid-job does the same, so the 3-attempt cap holds.
- The form uses `novalidate` and sends `Number(value)` for numeric fields, so the API's rejection reaches `form-error`.
- Empty numeric fields therefore send `0`, which the API rejects as an invalid `steps` or `failAttempts`.

**Manual end-to-end run** (scratch DB, `curl`), all as the spec requires:
- Health reports `up` while the worker runs and `down` about 3.5 s after `kill -9`.
- Validation returns 400 with the named field for each case I tried. Routing returns 405 and 404 correctly.
- Retries: `failAttempts` 1 completes on attempt 2, 2 completes on attempt 3, and 3 ends `failed` with `transient failure` on attempt 3.
- Idempotency returns 201, then 200 with the same id, then 409 for a different payload.
- Progress climbs (5/10 observed mid-run), then completes with `PROGRESS`.
- A `steps:20` job survives a `kill -9` of the worker and completes after restart.
- Both processes exit on SIGTERM.

**Not verified:** I did not check the UI in a real browser, and I did not restart the server to replay an idempotency key. Both rely on the code as written.