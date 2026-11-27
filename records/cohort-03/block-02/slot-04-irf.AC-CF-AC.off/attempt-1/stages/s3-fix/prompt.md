A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/db.ts:147 — Restart recovery erases processing attempts that already started.
   Evidence: `recoverInterruptedJobs()` decrements `attempts`, and graceful shutdown does the same through `requeueJob(..., false)` at src/worker.ts:54. An in-memory reproduction showed the first claim reporting 1, recovery resetting it to 0, and the second claim reporting 1 again. This violates the definition of `attempts` as the number of processing attempts started so far and loses durable job history.
   Fix: Preserve `attempts` when requeuing interrupted jobs, both during startup recovery and graceful shutdown. Increment it when processing starts again, and ensure retry decisions use the preserved attempt count.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
