Both findings are fixed, and the build and both check suites pass (smoke 2/2, contract 5/5).

**Finding 1, lossless text:** `input` and `output` are now stored as JSON text and decoded on read. Through the HTTP API, `"a\u0000b\ud800c"` is stored, processed, and returned unchanged. The worker uppercases the decoded string, so the output is `"A\u0000B\ud800C"`.

**Finding 2, attempt counting:** An interrupted attempt is no longer subtracted from `attempts`. It counts as a failed attempt, so the job is requeued if attempts remain, and otherwise fails with `transient failure`. This applies to startup recovery after SIGKILL and to graceful SIGTERM. I checked these cases:
- SIGKILL mid-run on a `failAttempts: 0` job: the next run is attempt 2 and completes.
- SIGKILL during attempt 3 of a `failAttempts: 2` job: the job ends `failed` with `attempts: 3`.
- SIGTERM mid-run: the next run is attempt 2 and completes.

One judgment call to review: this means a crash during attempt 1 of a job with `failAttempts: 0` now shows `attempts: 2` after recovery. That matches "attempts = attempts started", but a job that is crashed three times fails even if its simulated failures were never exhausted. I think that is the correct reading of "3 attempts in total", but it is a change in behaviour.

`src/store.ts` changed on disk during this stage. I read the current file and built on it, and I didn't revert anything. No fixed files were touched.