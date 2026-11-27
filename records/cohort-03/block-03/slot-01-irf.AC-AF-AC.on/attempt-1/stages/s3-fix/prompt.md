A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:20-21 (with :26-27, :65-72) — A job that is interrupted and then recovered can end with `attempts` above 3. If the worker dies or gets `SIGTERM` during an attempt, `attempts` has already gone up. On restart, `recoverRunning` sets the job back to `queued` but leaves `attempts` as it was, and `claim` adds 1 again. So if attempt 3 is interrupted, the rerun becomes attempt 4. With `failAttempts >= 4` the job ends `failed` with `attempts: 4`, but the spec requires 3. With `failAttempts: 2` the job completes with `attempts: 4`, so the 3-attempt limit no longer holds. A graceful `SIGTERM` causes the same problem, because `runAttempt` returns early and leaves the job `running` (:67, :78).
   Evidence: `recoverRunning` changes only status, progress and run_after. `claim` always runs `attempts = attempts + 1`. The fail/complete check compares the new `job.attempts` against `fail_attempts` and `MAX_ATTEMPTS` without a cap.
   Fix: Don't let an interrupted attempt use up a slot. In `recoverRunning`, set `attempts = MAX(attempts - 1, 0)` so the rerun reuses the same attempt number. Or, on graceful stop, requeue the current job with `attempts = attempts - 1` before exiting. Also add a guard in `claimNext`/`runAttempt`: if a claimed job's attempts would go past `MAX_ATTEMPTS`, mark it `failed` with `"transient failure"` and keep `attempts` at 3.

2. [minor] src/server.ts:237 — A malformed percent-encoded job id makes `decodeURIComponent` throw, so `GET /api/jobs/%E0%A4%A` returns `500 internal_error` when it should return `404 not_found`.
   Evidence: There is no try/catch around `decodeURIComponent`. The error goes up to the generic 500 handler at :248-251.
   Fix: Wrap the decode in try/catch and send `sendError(res, 404, 'not_found', ...)` when it fails.

3. [minor] src/worker.ts:40-42, 92 — `beat()` runs inside `setInterval` without error handling. If the write fails, for example with `SQLITE_BUSY` after the 5 s busy timeout while the server holds a write lock, the exception is uncaught and the worker crashes. Any other DB error in the main loop (`claimNext`, `setProgress`, `markCompleted`) also kills the process through `main().catch → process.exit(1)`, and nothing restarts it.
   Evidence: There is no try/catch around `upsertBeat.run` or the per-job DB writes. The process exits with code 1 on the first failure.
   Fix: Wrap `beat()` in try/catch and log the error. In the main loop, catch errors per iteration, log them, sleep `POLL_MS` and continue, so one failed write doesn't take the worker down.

I only read the code. I couldn't build or run anything here, so none of these were reproduced at runtime. The rest matches the task as written: validation, idempotency (a transaction plus a UNIQUE key), routing with 404/405, the health heartbeat, step timing, retry delay, the `failed` path, crash recovery, and the UI test ids and polling.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
