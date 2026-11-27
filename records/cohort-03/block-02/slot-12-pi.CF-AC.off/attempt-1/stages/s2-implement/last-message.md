The job tracker is implemented. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass.

**What changed** (only `src/` and `ui/`; fixed files and `checks/` untouched):
- **`src/db.ts`**: `openDatabase` keeps its original pragma order, then creates the schema with `IF NOT EXISTS`. It also holds the transactional job operations: claim, progress, complete, retry, fail, heartbeat, and idempotent insert.
- **`src/jobs.ts`** (new): validation, the `Idempotency-Key` check, canonical payload comparison, and the single public job serializer.
- **`src/server.ts`**: routing with JSON 404/405 errors, body parsing, idempotent `POST`, health from the worker heartbeat, and graceful shutdown.
- **`src/worker.ts`**: sequential worker with a 500 ms heartbeat, 100 ms steps, and durable retries (500 ms delay, 3 attempts max). It replays `running` rows on startup and exits cleanly on SIGTERM/SIGINT.
- **`ui/index.html`**: the form, the required `data-testid` elements, DOM-safe rendering, and 500 ms polling.

**Verification beyond the supplied checks** (temp DB, free ports, run from `$TMPDIR`):
- Retries: `failAttempts` 3 and 5 both end `failed` with 3 attempts and `"transient failure"`. `failAttempts` 2 completes on attempt 3.
- Progress is visible mid-run (`running 8/20`), and Unicode output is uppercased (`HÉLLO SS`).
- Validation, 404/405 routing, and idempotency (201, then 200 replay, then 409 conflict) behave as specified.
- SIGKILL of both processes mid-job: after restart the job was recovered and completed.
- Health goes `down` (server alone) → `up` (worker running) → `down` 3.5 s after the worker was SIGKILLed. SIGTERM exits both processes cleanly.

**Choices you may want to review:**
- An interrupted `running` attempt is replayed with its attempt number unchanged, so a crash during attempt 3 cannot push the job past three attempts.
- Request bodies over 64 KB are rejected as `invalid_request` on `body`. The spec doesn't set a limit.
- The UI sends a blank numeric field as `null` so the API rejects it. It resets the form to defaults after a successful submit.

**Not verified:** I did not drive the browser page interactively. I only checked that its script parses and that the HTML is served. I also did not run the `checks/` suite against the restart scenarios, since it doesn't cover them.

I didn't commit anything. The untracked dotfiles in the repo were already there, and I left them alone.