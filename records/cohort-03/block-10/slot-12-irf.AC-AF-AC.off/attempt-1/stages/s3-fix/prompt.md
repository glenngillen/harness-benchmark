A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:51-58, 76-80 — After a crash or graceful stop in the middle of a succeeding attempt, recovery puts the job back in the queue and the next pick increments `attempts` again. This breaks the "up to 3 attempts in total" rule.
   Evidence: Take `failAttempts: 2` and kill the worker during attempt 3, which would succeed. The job is stored as `running` with `attempts=3`. `recoverInterruptedJobs` sets it to `queued`. `processJob` then sets `attempts = 4` and completes the job, so the API reports `attempts: 4`. With `failAttempts: 0`, repeated restarts also push `attempts` past 3. On SIGTERM the worker deliberately leaves the job `running` (line 89), so this also happens on every clean restart.
   Fix: Retry the interrupted attempt instead of starting a new one. One way is to queue it with a flag or column such as `resume_attempt=1`, which `processJob` honours by not incrementing `attempts`. Another is to cap at `MAX_ATTEMPTS` by reusing the current count when `attempts >= MAX_ATTEMPTS` and the job is not a failing attempt.

2. [minor] src/worker.ts:108-116 — If any DB call fails partway through `processJob` (for example `SQLITE_BUSY` after the 5 s busy_timeout while the server holds a write lock), the job stays `running` forever. Recovery only runs at worker startup.
   Evidence: The catch in the main loop only logs the error and sleeps. Nothing resets the job, and `nextQueuedJob` only selects `queued` rows, so the job is never picked up again until the worker restarts.
   Fix: In the catch, or in a try/catch inside `processJob`, set the job back to `queued` (keeping the current attempt count, as in finding 1). Alternatively, run `recoverInterruptedJobs()` again whenever the loop recovers from an error.

The rest looks right to me: validation, the idempotency transaction, health, routing (404/405), UI test IDs, polling, and the build and import setup. All findings come from reading the code. I didn't build or run anything.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
