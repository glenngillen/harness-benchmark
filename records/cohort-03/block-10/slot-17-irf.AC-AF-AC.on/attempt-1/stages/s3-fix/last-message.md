All three findings were correct, and I've fixed them. The build passes, `check:smoke` passes 2/2, and `check:contract` passes 5/5.

**Changes in `src/worker.ts`**

1. **Attempts above 3 after a crash (finding 1, option a).** An attempt that is interrupted is no longer counted. Crash recovery and the interrupt path both run `attempts = MAX(attempts - 1, 0)`, so the re-run uses the same attempt number. A kill-loop test confirmed this: a `failAttempts: 2` job was killed mid-run three times, then completed with `attempts: 3`. Note that `attempts` now means "attempts that finished or failed," not "attempts started." The earlier summary described it the other way.
2. **Jobs stuck `running` after a DB error (finding 2).** If an attempt throws, the worker now runs an `interruptStmt` to requeue the job under the normal rules. Graceful shutdown mid-job also uses it, so the job is requeued immediately rather than waiting for the next startup.
3. **Stale progress on queued jobs (finding 3).** Recovery, the interrupt path, and the retry requeue all reset `completed = 0`.

The reviewer's "repeated kills during attempt 1 or 2" case is covered by the same decrement rule.