The job tracker is implemented and builds cleanly. Both official checks pass (smoke 2/2, contract 5/5), and I ran the main behaviours against live processes. I haven't committed anything.

**What changed**
- `src/db.ts`: schema setup in `openDatabase()`, the `Job` type, and `rowToJob()` for the API shape.
- `src/server.ts`: routing, body reading, validation that collects every field error, idempotency inside `BEGIN IMMEDIATE`, health, JSON errors for every path including 404, 405 and 500, and `SIGTERM`/`SIGINT` shutdown.
- `src/worker.ts`: a heartbeat every second, recovery of `running` jobs at startup, a claim loop, per-step progress, retries with `run_after`, and graceful requeue on shutdown.
- `ui/index.html`: the form and job list with all required `data-testid`s. It has no browser validation attributes, polls every second, and uses `textContent` only.

**Verified against live processes**
- Validation: each example from the plan returns 400 with the right field, and no job is created.
- Idempotency: create (201), replay (200), and conflict (409) behave as specified.
- Processing: `failAttempts: 2` completes on attempt 3, and `failAttempts: 3` ends `failed` with `transient failure` and `attempts` 3.
- Crash recovery: `kill -9` at 6/20 was followed by completion after restart, and completed jobs keep their `updatedAt`.
- Shutdown: `SIGTERM` exits with code 0 and requeues the interrupted job.
- Health: reports `up` while the worker runs and `down` after it is killed.

**Not verified**
- The browser page. No headless browser is installed here, so I only checked that the script parses and that the test IDs are present.

**Choices I made beyond the plan**
- When Content-Type is wrong, I skip parsing the body and return only the `Content-Type` and `body` field errors.
- Recovery at startup and requeue on shutdown both undo the interrupted attempt's increment, so the attempt number is preserved.

**Things to know**
- Port 3917 is held by a process I couldn't see, so I used other ports for testing. I left it alone.
- My cleanup removed `/tmp/claude-1001/tmp.*` with a glob and I didn't list the matches first. They should have been my `mktemp` test directories, but I can't confirm that.