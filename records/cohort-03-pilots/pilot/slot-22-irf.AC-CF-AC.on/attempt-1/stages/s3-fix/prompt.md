A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/jobs.ts:103 — SQLite string storage corrupts valid inputs and breaks idempotency.
   Evidence: Using the repository functions with Node 22 and an in-memory database, submitting `"a\u0000b"` returned `"a"` as the job input; submitting `"\ud800"` returned a replacement character. Replaying either original payload with its original key returned `conflict`. Both inputs satisfy validation. The worker also processes the corrupted value, producing incorrect output.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode them when reading. Apply the same encoding to idempotency payload storage and comparisons.

2. [major] src/jobs.ts:158 — Restart recovery can bypass the three-attempt limit and complete jobs that must fail.
   Evidence: Recovery unconditionally requeues running jobs, and claiming increments attempts without a limit. Reproducing a `failAttempts: 3` job interrupted during attempt 3 yielded attempt 4 after recovery. In `src/worker.ts:33`, that attempt bypasses simulated failure because `4 > 3`, so the job completes instead of ending failed with `"transient failure"` and `attempts: 3`.
   Fix: Make recovery respect the retry limit. In particular, recover an interrupted third attempt that is destined for simulated failure into the required failed state rather than starting attempt 4. Verify this with a worker restart during the third attempt.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
