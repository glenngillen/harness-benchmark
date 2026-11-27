All three findings are fixed. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) pass.

**Changes**
- **Finding 1 (attempt limit on crash):** On worker startup, a job left `running` that has already used 3 attempts is now marked `failed` with `"transient failure"`. Other interrupted jobs are requeued. `claimNext` also skips any queued job with `attempts >= 3`.
- **Finding 2 (attempt count on stop):** `abortAttempt` no longer decrements `attempts`. A started attempt stays counted on both the graceful-stop and crash paths. I chose this rule because it matches the spec's definition of `attempts`, and finding 1 keeps the total within 3.
- **Finding 3 (worker crashes):** The main loop and heartbeat are wrapped in error handling. Errors are logged and the loop retries after 200 ms. If an attempt errors partway through, the job goes back to `queued` instead of staying `running`. Startup recovery is retried in the loop too, so a transient database error there does not end the process.

**Verified:** I killed the worker with SIGKILL during attempt 3 of a `failAttempts: 2` job. After restart the job ended `failed` with `attempts: 3` and `error: "transient failure"`, rather than running a fourth attempt.