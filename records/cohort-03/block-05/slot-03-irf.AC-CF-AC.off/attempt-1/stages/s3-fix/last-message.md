Both findings are fixed, and the build and both check suites pass.

**Finding 1 (restart erases started attempts): fixed.** Recovery of abandoned jobs and graceful-shutdown rollback no longer decrement `attempts`. The job in my test was SIGKILLed during its first attempt, and after restart it reported `attempts: 2` on completion.

To keep the retry rules correct once interrupted attempts stay counted, I added a `failed_attempts` column. An attempt fails only while fewer than `failAttempts` attempts have failed, and the job fails after the third failure. Without this, a job interrupted on attempt 3 could fail on attempt 4 with `attempts: 4`. Since the two counters are separate, `attempts` is simply the number of starts.

**Finding 2 (64 KiB body limit): fixed.** I removed the body-size check and the 413-style rejection. A 64 KiB-plus-whitespace body with a valid `input` now returns 201. The tradeoff is that the server reads any request size into memory, which is acceptable for this local app but would be a concern in production.

I verified:
- `failAttempts: 3` still ends `failed` with `attempts: 3`.
- The large-whitespace body is accepted.
- The SIGKILL-and-restart case completes.

Nothing is committed.