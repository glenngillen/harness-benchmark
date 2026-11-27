The job tracker is implemented in `src/` and `ui/`. `npm run build` passes, `check:smoke` passes 2/2, and `check:contract` passes 5/5. I haven't committed anything.

**What I changed**
- `src/db.ts`: opens SQLite in WAL mode with busy timeout, creates the schema (`jobs`, `idempotency_keys`, `worker_heartbeat`), and provides an `IMMEDIATE` transaction helper.
- `src/validation.ts` (new): request validation for all rules in the spec, collecting every offending field. It covers unknown fields, wrong types, numeric strings, range and integer checks, malformed JSON, non-object bodies, Content-Type, and the `Idempotency-Key` pattern.
- `src/jobs.ts` (new): the job JSON mapping, and submit in one transaction so a key can never create two jobs. A replay with the same payload returns 200. A different payload returns 409.
- `src/server.ts`: routes, `/health` (worker is `up` if its heartbeat is under 3 s old), `GET /`, and 404/405 handling. It shuts down on SIGTERM and SIGINT.
- `src/worker.ts`: polls every 200 ms and claims the oldest due job atomically. Each step is 100 ms and writes progress. It retries simulated failures after 500 ms, up to 3 attempts, then fails with `transient failure`. It writes a heartbeat every second and requeues `running` jobs on startup. On SIGTERM it requeues the in-flight job and exits.
- `ui/index.html`: the form and job list with all the required `data-testid` values. It polls every second, shows rejections with field names, and renders text with `textContent`.

**Choices I made where the spec was open**
- An attempt interrupted by a crash or SIGTERM still counts in `attempts`, since it was started. So a job killed mid-run shows `attempts: 2` after recovery.
- Numeric form text is sent as a number. Empty or non-numeric text is sent as a string, so the API rejects it. The form prefills steps 5 and fail attempts 0.
- A body over 64 KB is rejected with `400 invalid_request` on field `body`.
- The worker assumes it is the only worker. Starting a second one would requeue the first one's running jobs at startup.

**Verification**
- Both suites pass, as listed above.
- I also ran the lifecycle by hand on a fresh database: `failAttempts: 3` ends failed with `attempts: 3`, and `failAttempts: 2` completes on attempt 3. Recovery after a worker SIGKILL mid-job completes the job. An idempotency key still replays after a server SIGKILL. Both processes exit cleanly on SIGTERM.
- I did not test the UI in a real browser; I only checked the markup and script by reading them.
- Port 3917 is held by a process I can't see. It is not mine, so I left it alone and used port 4821 instead.