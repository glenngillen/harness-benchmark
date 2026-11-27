All three findings were correct, and I fixed all three. The build passes, and both fixed suites pass (smoke 2/2, contract 5/5).

- **Attempt double-count (finding 1):** an interrupted attempt is now requeued with `attempts` decremented, both at startup recovery and on shutdown. The next claim counts it again, so `attempts` never exceeds 3. I checked this directly: a `failAttempts: 2` job killed during its successful attempt 3 completes with `attempts: 3`.
- **Retry delay (finding 2):** `RETRY_MAX_MS` is now 1500 instead of 2000, so the delay plus the 200 ms poll stays under 2 s.
- **Stranded `running` job (finding 3):** the worker loop now catches errors from `processAttempt` and requeues the job with the same rule. If that requeue also fails, the job stays `running` until restart, and the log says so.

One trade-off: `attempts` now reads one lower while an attempt is interrupted and requeued. It still counts only attempts that actually ran to a conclusion.

I did not reproduce the `failAttempts: 5` case with a kill during attempt 3's failing step, or the error-path requeue. Both rely on the same decrement logic that I did test.