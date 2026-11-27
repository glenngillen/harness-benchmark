# Review findings

1. [major] src/worker.ts:45-60, 75, 96 — A job interrupted during an attempt can go past the 3-attempt limit, and can end `failed` with `attempts` other than 3.
   Evidence: `runAttempt` increments `attempts` in `markRunning` before any work. `requeueRunning` runs on startup and on SIGTERM. It puts the job back to `queued` but keeps the incremented `attempts`. The next pickup then runs attempt `job.attempts + 1` with no upper bound. Two examples:
   - A job with `failAttempts: 5` is killed while running attempt 3. On restart it runs attempt 4, fails it, and is marked `failed` with `attempts = 4`. The spec says `attempts` is 3.
   - A job with `failAttempts: 0` that is interrupted three times keeps going to attempt 4, 5, and so on. Each SIGTERM in the middle of a step also uses up an attempt, because `if (stopping) return` leaves the job `running` and it is then requeued.
   Fix: When recovering a `running` job, choose one approach and apply it the same way everywhere:
   - (a) Treat the interrupted attempt as not counted: decrement `attempts` in `requeueRunning`, for example `attempts = MAX(attempts - 1, 0)`, so the rerun reuses that attempt number.
   - (b) Treat it as counted: in `runAttempt`, if `job.attempts >= MAX_ATTEMPTS` before starting, mark the job `failed` with `attempts = 3` and `error = 'transient failure'` instead of starting attempt 4.
   Also clamp `attempts` so it never goes above 3.

2. [major] src/worker.ts:84-92 — If any DB write inside `runAttempt` throws, the job is left `running` for good, at least until the worker restarts.
   Evidence: The loop's `catch` only logs and sleeps. A `SQLITE_BUSY` after the 5 s busy_timeout, or any other error from `markProgress`, `markCompleted` or `markRetry`, leaves the row `status='running'`. `nextQueued` only selects `queued`, and `requeueRunning` only runs at process start and stop. The job never finishes. That breaks the guarantee that a job completes or fails per the retry rules.
   Fix: Catch errors inside `runAttempt`, or in the loop for the current job, and put that job back to `queued` with a `next_run_at` delay. Alternatively, have the loop periodically requeue `running` rows that aren't the job currently in flight. This is safe because there is a single worker.

3. [minor] ui/index.html:48-53 — `fieldValue` uses `Number()`, which accepts formats the API should see as typed. `"0x3"`, `"1e1"` and `" "` (an empty string after trim is skipped) are converted silently. For example, `steps = "0x10"` becomes `16` and passes as a valid integer.
   Evidence: `Number("0x10") === 16` and `Number("1e1") === 10`.
   Fix: Convert only plain decimal numbers, e.g. `/^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed`, so anything else reaches the API as a string and is rejected with the field named.

4. [minor] src/worker.ts:49-51 — A SIGTERM during the first step of a failing attempt returns without recording the failure or a retry. The job stays `running` until the shutdown requeue, and the attempt it already counted is lost (see finding 1).
   Evidence: `await sleep(STEP_MS); if (stopping) return;` comes before `markRetry`/`markFailed`.
   Fix: Record the failure before checking `stopping`, or make sure it's covered by the attempt-accounting fix in finding 1.

Note: I only had read-only file tools, so these findings come from reading the code. I did not build or run the app. The rest of what I reviewed looks correct as written: validation, idempotency (transaction plus UNIQUE key), routing, 404/405 handling, heartbeat and health, durability (WAL plus `synchronous=FULL`), the UI test ids, and polling.