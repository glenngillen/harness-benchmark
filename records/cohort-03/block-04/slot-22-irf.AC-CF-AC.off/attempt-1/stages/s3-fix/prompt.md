A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:47 — Restart recovery can bypass the three-attempt limit and complete a job that must fail.
   Evidence: Startup requeues every running job, and `claim()` unconditionally increments its attempts. An in-memory reproduction seeded a running job with `attempts: 3` and `failAttempts: 3`, representing interruption after claiming attempt 3. Recovery produced `status: "completed"`, `attempts: 4`, and output `"HELLO"` because attempt 4 bypasses the simulated failure condition. The contract requires this job to end failed with `"transient failure"` and exactly 3 attempts.
   Fix: Handle exhausted transient-failure attempts during recovery before requeuing or claiming them. Persist the required failed state with a null result, and ensure restarting cannot advance these jobs beyond attempt 3.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
