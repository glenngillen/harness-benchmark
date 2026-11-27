# Review findings

1. [major] src/jobs.ts:144 — `recoverInterruptedJobs` marks any `running` job with `attempts >= 3` as `failed` ("transient failure") and never runs it again. The task says a job that was `running` when the worker died "is processed again" and completes or fails according to the retry rules. Take a job with `failAttempts` 0–2 that is killed during attempt 3, which would have succeeded: it ends `failed` with an error that never happened. The same thing happens to a `failAttempts: 0` job that is interrupted three times.
   Evidence: line 144's UPDATE runs before the requeue on line 149, and its only condition is `attempts >= MAX_ATTEMPTS`. It does not check whether the attempt would have failed under `failAttempts`.
   Fix: don't fail jobs that were never processed again. Either requeue every interrupted job, or only fail it when its next attempt would itself be a failing attempt beyond the limit. A cleaner option is to not count an interrupted attempt toward the retry limit: when recovering, requeue with `attempts = attempts - 1`, or track transient failures in a separate counter so that only real transient failures move the job toward `failed`. Keep `attempts` as "attempts started" if you can, but the job must end `completed` when its `failAttempts` allows it.

2. [minor] src/worker.ts:58 — On a graceful `SIGTERM` in the middle of an attempt, the worker leaves the job `running` and relies on the next start to recover it. Combined with finding 1, a few routine restarts can push a healthy job to `failed`. Also, until a worker starts again, the job sits in `running` with stale progress.
   Evidence: `if (stopping) return;` returns without touching the database row.
   Fix: before exiting, set the interrupted job back to `queued` (`completed = 0`, `run_after = 0`). Don't count that attempt toward the limit.

3. [minor] src/worker.ts:37 — If the heartbeat `setInterval` callback throws (for example, `SQLITE_BUSY` after the 5 s busy timeout while the server holds a write lock), the exception is uncaught and the worker process crashes. The main loop catches its own errors; the heartbeat callback has no try/catch.
   Evidence: `setInterval(() => writeHeartbeat(db), ...)` has no error handling.
   Fix: wrap `writeHeartbeat` in try/catch and log the error.

4. [minor] src/validation.ts:30-41 — Errors about the body as a whole return early, so an invalid `Idempotency-Key` sent with a bad Content-Type, malformed JSON, or a non-object body is not reported. The task requires each offending field to be listed in `fields`.
   Evidence: `bodyError(...)` returns `[{field:"body"}]` before the key is checked on lines 67-73.
   Fix: check the `Idempotency-Key` header first, keep any error in a list, and add the `body` error to that list instead of returning early.