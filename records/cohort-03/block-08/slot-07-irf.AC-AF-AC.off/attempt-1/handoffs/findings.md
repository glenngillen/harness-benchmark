# Review findings

1. [major] src/worker.ts:27 — Restarting the worker after it died mid-job counts the interrupted attempt and then starts another one. That breaks the 3-attempt limit and the `failAttempts` outcome.
   Evidence: Recovery re-queues `running` rows but leaves `attempts` as it was, and `claim()` adds 1 again. Two cases:
   - A job with `failAttempts: 3` killed during attempt 3 (the 100 ms sleep before it fails) is claimed again as attempt 4. `runAttempt` checks `4 <= 3`, which is false, so the job runs every step and ends `completed`. The task says it must end `failed`.
   - With `failAttempts: 0..2`, a job killed during attempt 3 runs a 4th attempt and ends `completed` with `attempts: 4`. With `failAttempts: 4..5`, it ends `failed` with `attempts: 4`. The task requires 3 attempts at most, and `attempts: 3` on failure.
   Fix: In the recovery UPDATE, don't count the interrupted attempt: `SET status='queued', attempts = MAX(attempts-1, 0), completed = 0, run_after = 0 ... WHERE status='running'`. Then a re-run is still attempt n, and the `attempts <= fail_attempts` and `MAX_ATTEMPTS` checks stay correct. If you would rather keep the attempt counted, then for rows with `attempts >= 3` decide the outcome during recovery instead of claiming again: `failed` if `attempts <= fail_attempts`, otherwise re-run with `attempts` held at 3. Either way, make sure `attempts` never goes above 3.

2. [minor] src/worker.ts:108-112 — If a DB write fails inside `runAttempt` (for example `SQLITE_BUSY` after the 5 s timeout, in `setProgress`, `finishCompleted` or `requeue`), the error is logged and the job stays `running` until the worker restarts. Nothing retries it, so it never finishes while the worker is up.
   Evidence: The catch block only calls `console.error`. The claim query only selects `status = 'queued'`.
   Fix: In the catch, try to put the job back to `queued`, either with a short `run_after` or through the retry/fail rules, so a write error can't strand the job.

3. [minor] src/worker.ts:31-38 — If the heartbeat write throws (for example `SQLITE_BUSY` while the server holds a long write lock), the exception escapes from `setInterval`. That is an uncaught exception, and it kills the worker process.
   Evidence: `beat` is passed straight to `setInterval` with no try/catch around it.
   Fix: Wrap the body of `beat` in try/catch and log the error, so one failed heartbeat doesn't crash the worker.

I found no other problems in validation, idempotency, routing, health, shutdown or the UI. I only read the code: I didn't build or run anything, because my tools here can only read files.