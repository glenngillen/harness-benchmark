A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:32 — Restart recovery can exceed the three-attempt limit and incorrectly complete a job that should fail.
   Evidence: Recovery requeues every running job, and `claimNext()` unconditionally increments `attempts`. Running the worker logic against an in-memory interrupted job with `attempts: 3` and `failAttempts: 3` produced `status: "completed"`, `attempts: 4`, and output `"HELLO"`. This state can arise when the worker receives SIGKILL during the third attempt’s initial delay; SIGTERM also requeues that attempt.
   Fix: Handle exhausted transient-failure attempts during recovery and shutdown instead of starting attempt four. An interrupted third attempt with `failAttempts >= 3` should become failed with `"transient failure"` and `attempts: 3`. Preserve recovery for interrupted successful processing, and verify both SIGTERM and SIGKILL scenarios.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
