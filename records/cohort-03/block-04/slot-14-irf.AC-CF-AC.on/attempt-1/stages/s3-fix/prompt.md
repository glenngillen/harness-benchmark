A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:36 — Restart recovery can exceed the three-attempt limit and complete a job that should fail.
   Evidence: Recovery requeues every running job, and `claimNext` unconditionally increments its attempts. Exercising recovery with a running job having `attempts: 3` and `failAttempts: 3` produced `status: "completed"`, `attempts: 4`, and output `"HELLO"`. This state can occur when the worker stops during the third attempt’s first step.
   Fix: Handle exhausted attempts during recovery and enforce the attempt limit when claiming jobs. An interrupted third attempt with `failAttempts >= 3` must end failed with `"transient failure"` and `attempts: 3`.

2. [major] src/jobs.ts:105 — SQLite text storage does not preserve all valid JavaScript input strings.
   Evidence: Calling `submitJob` against an in-memory database with input `"a\u0000b"` returned input `"a"`; input `"\ud800"` returned `"�"`. Both pass the specified validation. The worker also reads this altered input, so its uppercase output is incorrect.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode them when constructing job objects and processing input. Verify round trips and uppercase results for embedded NUL characters and unpaired surrogates.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
