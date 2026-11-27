The job tracker is implemented. It builds, and both fixed checks pass: smoke 2/2 and contract 5/5. I also ran the main behaviours by hand against a scratch database. I did not open the page in a real browser.

**Changed files** (only `src/` and `ui/`; nothing else touched, nothing committed):
- `src/db.ts`: `openDatabase` now creates the schema (`CREATE IF NOT EXISTS`). It also exports the `Job` type and `toJob`, which forces `result` and `error` to null unless the status calls for them.
- `src/server.ts`: rewritten as a `node:http` server with routing, validation, idempotency, `/health`, the static page, and graceful SIGTERM/SIGINT shutdown.
- `src/worker.ts`: rewritten as a polling worker with a 500 ms heartbeat, crash recovery, retries, progress updates, and graceful shutdown.
- `ui/index.html`: the form, error region, job list, and a 1 s polling script. It uses `textContent` only.

**Verified by hand:**
- Every validation case in the plan returns 400 with the right field, and no job is created. `steps: 3.0` is accepted.
- Retries: `failAttempts` 1, 2, and 3 give completed/2, completed/3, and failed/3 with the transient error.
- Idempotency: replay returns 200 with the same id, a different payload returns 409, and the key still replays after a server restart.
- Routes: 405 for `DELETE /api/jobs`, 404 for unknown paths and ids.
- Crash recovery: after `kill -9` on the worker mid-job, health showed `down` within 3 s. A restarted worker completed the 20-step job with attempts 1.
- SIGTERM exits with code 0 for both processes, including with a keep-alive connection open.
- The page's script parses, and `/` serves the HTML with all the `data-testid` markers.

**Choices I made:**
- Crash recovery and graceful shutdown both decrement `attempts`, so an interrupted attempt does not count. A job interrupted on attempt 3 shows 3 attempts after it finishes, not 4.
- The UNIQUE-constraint fallback from the plan is not implemented. It cannot trigger, because the key check and insert run inside `BEGIN IMMEDIATE`.
- Oversized bodies (over 1 MB) return a `body` field error.

**Not verified:** the UI behaviour itself. Live status and progress updates, and form-error showing `steps` for `steps=25`, rest on reading the code, since I had no browser to drive.