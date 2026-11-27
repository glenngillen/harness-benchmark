Both findings are fixed, and the build and both check suites pass.

- **Attempt count after interruption (finding 1):** I took the reviewer's first option. `recover` (the startup reset of `running` jobs) and the graceful-stop requeue now both undo the attempt that was interrupted, with `attempts = MAX(attempts - 1, 0)`. A job that is killed or stopped repeatedly no longer climbs past 3. In my test a `failAttempts: 2` job was killed three times and then completed with `attempts: 3`, which is correct: two failed attempts, then a success.
- **Heartbeat crash (finding 2):** `beat()` now wraps the write in `try/catch` and logs the error. The next tick retries, so a busy or failing database no longer kills the worker.

I did not change anything else. Both findings were valid, so I declined none.