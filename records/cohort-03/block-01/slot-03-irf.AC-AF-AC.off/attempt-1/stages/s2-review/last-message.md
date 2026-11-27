# Review findings

1. [major] src/worker.ts:40-50, 53-75, 111-127 — An interrupted attempt still counts toward the limit, but nothing stops a 4th (or later) attempt from starting. So `attempts` can go above 3, and the outcome can be wrong after a restart.
   Evidence: Reading the code (I could not run anything in this review): `claimNext` always does `attempts = attempts + 1` with no cap. `runAttempt` only checks `MAX_ATTEMPTS` inside the simulated-failure branch (`job.attempt < MAX_ATTEMPTS`). `recoverInterruptedJobs` after a SIGKILL, and `requeueForRetry` on SIGTERM (lines 115, 123), both put the job back in the queue without undoing the attempt they counted. Two traces:
   - `failAttempts: 0`, worker killed during attempt 3. After restart, attempt 4 runs and the job ends `completed` with `attempts: 4`.
   - `failAttempts: 3`, attempt 1 interrupted, then attempts 2 and 3 fail as simulated. The job ends `failed` with `attempts: 3`, but only two attempts actually failed.
   
   Worse, `failAttempts: 5` with any interruption can reach `attempt 4 <= 5` and end `failed` with `attempts: 4`. And `failAttempts: 3` with attempt 3 interrupted runs attempt 4, which is greater than 3, so the job completes even though the spec says `failAttempts: 3` must end `failed`. This breaks "up to 3 attempts in total" and "`attempts` set to 3".
   Fix: Never let `attempts` go past 3, and keep the fail-or-succeed decision tied to the real attempt number.
   - On graceful stop (SIGTERM path), undo the counted attempt when requeueing, e.g. `attempts = attempts - 1`.
   - In `recoverInterruptedJobs`, do the same: set `attempts = attempts - 1` for jobs that were `running`. This treats the dead attempt as never finished, so the re-run reuses the same attempt number.
   - Also add a guard in `claimNext`: if `row.attempts >= MAX_ATTEMPTS`, don't increment. Either re-run attempt number 3 or finish the job, failing it if `failAttempts >= 3`.
   
   Then check that a job interrupted on any attempt ends with `attempts ≤ 3` and that its final status matches the retry rules (`failAttempts ≤ 2` completes, `failAttempts ≥ 3` ends `failed`).

The rest held up on reading. Validation covers each listed case with the right `fields`, idempotency checks and inserts inside a single `BEGIN IMMEDIATE`, routing returns the right 404/405 errors, the heartbeat and the 3-second health window work, the WAL and busy_timeout setup is in place, SIGTERM shuts both processes down, the UI has every `data-testid` and polls every 1 second, and the build config and paths line up with `dist/`.