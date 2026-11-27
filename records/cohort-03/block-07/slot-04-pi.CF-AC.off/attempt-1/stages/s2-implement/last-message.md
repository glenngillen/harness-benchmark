The job tracker is implemented in `src/` and `ui/`. The build passes, both fixed check suites pass (smoke 2/2, contract 5/5), and a crash-recovery run behaved as specified. I did not run the browser page in a real browser.

**Changed files**
- `src/jobs.ts` (new): shared types, constants, the API job serializer, validation, and idempotency-key checks.
- `src/db.ts`: keeps the existing directory creation and busy-timeout-before-WAL ordering, and adds idempotent schema creation, atomic job creation with idempotency, listing, lookup, and heartbeat health.
- `src/server.ts`: routing (404 for unknown paths, 405 for wrong methods), body parsing, collected field errors, the 201/200/409 creation paths, health, and bounded `SIGTERM` drain.
- `src/worker.ts`: claims the oldest eligible job, runs one step per 100 ms with per-step progress, retries with a persisted 500 ms `available_at`, and fails after the third attempt. It also recovers interrupted `running` jobs on startup, writes a heartbeat every 500 ms, and shuts down cleanly.
- `ui/index.html`: the form, the `role="alert"` error region, and the job list with all required `data-testid`s. It renders with `textContent` and polls every 500 ms.

**Verified by hand**
- Retries: `failAttempts` 2 completes on attempt 3; 5 fails on attempt 3 with `transient failure`.
- Validation and idempotency: the 400, 409, and replay (200) paths return the expected codes.
- Crash recovery: a worker SIGKILLed mid-job reports `worker: down`. After restart the job completes once, with the interrupted attempt counted, and the replay returns 200 with one row. `integrity_check` is `ok`.

**Choices I made**
- An interrupted attempt is counted. A job interrupted on its third attempt fails with `transient failure` if the simulated-failure condition holds, otherwise with a worker-stopped message.
- The 500 ms retry delay is fixed, which is inside the required 250 ms–2 s window.
- The `POST` body is capped at 64 KB.

**Not verified**
- I did not test `SIGTERM` while a job is mid-processing; only idle shutdown and the kill path were exercised.
- The browser page was not exercised in a real browser.

**Incident to note:** Early in testing, port 3917 was already held by a process I don't own, so my first test run hit that server instead of my build. I did not signal it. The later crash test used my own captured PIDs. Earlier `pgrep`-based kill attempts matched only the sandbox's own `bwrap` (PID 1), which I confirmed is still running.