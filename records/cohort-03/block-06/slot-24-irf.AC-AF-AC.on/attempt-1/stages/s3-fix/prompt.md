A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:18, 38, 44-46, 72 — Interrupted attempts still count toward the attempt total. If the worker is killed (SIGKILL) or stopped (SIGTERM) mid-attempt, the job is put back in the queue with `attempts` already incremented, and the next claim increments it again. So `attempts` can go above 3, and the failure check `job.attempts <= job.fail_attempts` gives the wrong answer for jobs whose attempt number is now above 3.
   Evidence: Take a job with `failAttempts: 3` and kill the worker during the 100 ms sleep of attempt 3. Startup recovery (line 18) requeues it with `attempts=3`. The next claim makes it `attempts=4`. Then `4 <= 3` is false, so the job runs all its steps and ends `completed` instead of `failed` with `attempts: 3`. The same thing happens with `failAttempts: 2` if attempt 3 is interrupted. It finishes with `attempts: 4`, which breaks the "up to 3 attempts in total" rule.
   Fix: When an interrupted attempt is recovered, don't count it as a new attempt. In both the startup recovery and `requeueInterrupted`, set `attempts = MAX(attempts - 1, 0)` so the re-run reuses the same attempt number. Or add a column marking the job as interrupted and skip the increment in `claimNextJob` when it is set. Also clamp the claim so `attempts` never goes above `MAX_ATTEMPTS`. If a job already at 3 attempts is claimed again, run attempt 3 again; never start a 4th.

2. [minor] src/worker.ts:87-97 — The worker has no error handling around its database calls. If `claimNextJob`, a progress update, or a heartbeat throws (for example, `SQLITE_BUSY` after the 5 s busy timeout while the server holds the write lock), the exception goes unhandled. That kills the worker and leaves the job `running` until someone restarts it.
   Evidence: There is no try/catch in the main loop, in `runAttempt`, or in the `setInterval` heartbeat callback. A throw inside `setInterval` crashes the process.
   Fix: Wrap each loop iteration and the heartbeat callback in try/catch. Log the error, wait briefly, and continue. If an attempt throws partway through, put the job back in the queue (counting it as in finding 1) so it doesn't stay `running`.

3. [minor] src/server.ts:181-189 — On SIGTERM, `shutdown` calls `server.closeAllConnections()` straight away. This cuts off in-flight requests, including a `POST /api/jobs` whose transaction may already have committed. The client then gets a reset connection instead of the 201.
   Evidence: `closeAllConnections()` runs right after `server.close()`, with no grace period.
   Fix: Call `server.closeIdleConnections()` first. Then let active requests finish, and fall back to `closeAllConnections()` after a short timeout (about 2 s). That stays well inside the clean-shutdown window.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
