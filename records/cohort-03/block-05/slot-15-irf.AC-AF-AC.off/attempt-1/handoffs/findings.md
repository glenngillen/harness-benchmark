# Review findings

1. [minor] src/worker.ts:22 and src/store.ts:135 — When the worker restarts, it re-runs a job that was killed mid-attempt even if that job has already used all 3 attempts. The new attempt pushes `attempts` past `MAX_ATTEMPTS`.
   Evidence: `recoverInterrupted()` puts `running` jobs back to `queued` without checking `attempts`. `claimNext()` then does `attempts = attempts + 1`. Example: a job with `failAttempts: 2` is killed with `SIGKILL` during attempt 3. After restart it runs attempt 4 and completes with `attempts: 4`. The task says "up to 3 attempts in total".
   Fix: In recovery, if `attempts >= MAX_ATTEMPTS`, either mark the job `failed` (error `"transient failure"`), or reset it so the re-run reuses the interrupted attempt number instead of adding one (for example, decrement `attempts` there). Pick one rule and apply it to both the crash path and the graceful-stop path. Also make `claimNext` refuse to go past 3 attempts.

2. [minor] src/store.ts:167 (`abortAttempt`) — On graceful shutdown, the worker subtracts 1 from `attempts`. The task defines `attempts` as "the number of processing attempts started so far", so a started attempt should not be removed from the count.
   Evidence: The `SIGTERM` handler sets `stopping`. The step loop then calls `abortAttempt`, which runs `attempts = attempts - 1`. A client polling the job sees `attempts` go from 1 back to 0. After a `SIGKILL` the count is kept, so the two kinds of restart behave differently.
   Fix: Keep the decrement only if it is paired with the rule from finding 1, so that the total can never go over 3. Otherwise don't decrement, and enforce the 3-attempt limit when the job is claimed.

3. [minor] src/worker.ts:45-52 — Nothing in the main loop catches errors. One unexpected SQLite error, such as `SQLITE_BUSY` after the 5 s busy timeout, ends the worker process. A job left `running` then stays stuck until someone restarts the worker by hand, and `/health` reports `down`.
   Evidence: `claimNext()` and `runAttempt()` run with no `try/catch`. Errors from the `setInterval` heartbeat aren't caught either.
   Fix: Wrap each loop iteration and the heartbeat callback in `try/catch`. Log the error, sleep for `IDLE_MS`, and continue. If an attempt fails partway, put the job back in the queue (or recover it on the next loop) instead of leaving it `running`.

I read all of the source and UI. Validation, idempotency (handled inside a `BEGIN IMMEDIATE` transaction, with a `UNIQUE` key column), routing (404/405), the error shape, the health heartbeat, the queue order and retry delay, crash recovery, `SIGTERM` handling and the `data-testid` UI wiring all match the task. I didn't build or run the app, because only read tools were available.