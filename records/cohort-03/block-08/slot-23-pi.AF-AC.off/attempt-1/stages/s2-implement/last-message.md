The job tracker is implemented in `src/` and `ui/`. `npm run build` exits 0, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I also tested the behaviours the fixed checks don't cover. I did not commit anything.

**What I changed**
- **`src/db.ts`:** creates the `jobs`, `idempotency_keys`, and `heartbeat` tables, and adds a transaction helper and the job serializer.
- **`src/server.ts`:** routing with JSON 404/405 and a 500 fallback, validation that reports every bad field, idempotency inside one transaction, `/health` read from the heartbeat, and SIGTERM/SIGINT shutdown.
- **`src/worker.ts`:** a heartbeat every 500 ms, startup recovery of `running` jobs, a claim loop with retries, progress updates per step, and graceful shutdown.
- **`ui/index.html`:** the form, error region, and job list with the required `data-testid`s, polling every second. It uses `textContent`, so user input is never rendered as HTML.

**What I verified by running it**
- All 11 validation cases return 400 with the right `fields[].field`, and the job count stays unchanged.
- Idempotency returns 201, then 200 for a replay and 409 for a changed payload. It still holds after a server restart.
- `failAttempts: 2` completes with `attempts: 3`. `failAttempts: 3` fails with `"transient failure"` and `attempts: 3`.
- `GET /nope` returns 404, `DELETE /api/jobs` and `POST /health` return 405, and `GET /api/jobs/unknown` returns 404 `not_found`.
- After `kill -9` on the worker, `/health` reports `down`.
- Crash recovery: a 20-step job was killed at 11/20, and after a worker restart it completed with `attempts: 2`.
- SIGTERM stops both processes with exit 0 within about 100 ms.

**Choices I made where the plan was open**
- **Crash recovery does not cap attempts.** I did not adopt the planner's "fail at claim if `attempts >= 3`" rule. A job that crashed during a successful third attempt still completes. Simulated failures are decided in the same transaction as the claim, so they can't leave a job half-updated.
- **Graceful stop requeues the interrupted job.** It returns to `queued` with progress reset, and its attempt stays counted.

**Not verified**
- I did not load the UI in a real browser. I checked the required `data-testid` attributes in the markup and the script. The `job-status`, `job-progress`, `job-result`, and `job-item` elements are created by JavaScript, so they are not in the HTML source.