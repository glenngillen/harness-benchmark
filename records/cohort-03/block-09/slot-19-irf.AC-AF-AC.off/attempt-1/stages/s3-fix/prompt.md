A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:26-30 — When the worker reclaims a job whose lease has expired (after a crash or SIGKILL), it starts a new attempt and does `attempts = attempts + 1` with no upper limit. A job that was `running` on attempt 3 when the worker died restarts as attempt 4. It then either completes with `attempts: 4`, or, if it was failing, ends `failed` with `attempts: 4`. The task allows at most 3 attempts in total, and a `failed` job must have `attempts` set to 3. The inflated count also feeds the `job.attempts <= job.fail_attempts` check at line 70, so a crash can change whether the job succeeds or fails.
   Evidence: Found by reading the code; I could not run the app. `claimStmt` selects `status = 'running' AND lease_until < ?` without checking `attempts`. `startAttemptStmt` then increments `attempts` every time. Example: `failAttempts: 0`, kill the worker during attempt 3's steps (reachable after earlier crashes), restart it, and the job completes with `attempts: 4`. Example: `failAttempts: 5`, kill the worker during the 100 ms sleep of attempt 3, and the job ends `failed` with `attempts: 4`.
   Fix: In `claim()`, handle a reclaimed `running` job with `attempts >= MAX_ATTEMPTS` separately. Either rerun it without incrementing `attempts` (reset `completed` to 0, keep `attempts` at 3, and use 3 when deciding whether the attempt fails), or, if the interrupted attempt was a failing one, mark the job `failed` with `attempts = 3`. Add `MIN(attempts + 1, 3)` to the claim UPDATE as a guard, so `attempts` never goes above 3.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
