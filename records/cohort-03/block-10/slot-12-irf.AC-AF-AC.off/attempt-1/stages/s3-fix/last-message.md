Both findings are fixed. The build is clean, `check:smoke` passes 2/2, and `check:contract` passes 5/5.

**Changes (all in `src/worker.ts`)**
- **Finding 1 (attempt over-count): fixed.** An interrupted succeeding attempt is now requeued with `attempts - 1`, so its retry reuses the same attempt number. This covers a SIGKILL, a graceful stop, and a DB error. I tested it: `failAttempts: 2` killed during attempt 3 completed with `attempts: 3`, not 4. An interrupted *failing* attempt is still recorded as failed, as before.
- **Finding 2 (job stuck `running` after a DB error): fixed.** Any failed loop iteration sets a flag. The next iteration runs recovery before picking up work, and retries until the database accepts it. Recovery also runs once after the loop exits, so a SIGTERM releases the running job right away.

**Note:** `attempts` now means "attempts that finished or were started and not interrupted." An interrupted attempt is undone rather than counted, so a crash does not use up the retry budget. This is a deliberate interpretation of the spec, and the summary to the user should say so.