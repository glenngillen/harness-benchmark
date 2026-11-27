A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/jobs.ts:123 — SQLite storage corrupts valid input strings.
   Evidence: On the required Node 22 runtime, submitting `"a\u0000b"` through `submitJob()` returns input `"a"`; processing produces `"A"` instead of `"A\u0000B"`. An unpaired surrogate such as `"a\ud800b"` becomes `"a�b"`. Both inputs pass validation, but the contract requires exact preservation and JavaScript `toUpperCase()` output.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode them consistently when returning jobs and claiming work.

2. [major] src/jobs.ts:193 — Restart recovery decreases the durable attempt count and permits additional attempts without counting them.
   Evidence: Calling claim and recovery repeatedly yields claimed attempt numbers `1, 2, 3, 3`; recovery changes `attempts` from 3 back to 2. Thus a fourth processing attempt is reported as the third, and repeated restarts can bypass the three-attempt limit. The contract defines `attempts` as the number of attempts started.
   Fix: Never decrement `attempts`. Define recovery at the attempt limit explicitly, preserving the counter and enforcing the retry limit rather than reopening the budget.

3. [minor] src/server.ts:64 — The undocumented body-size limit rejects otherwise valid submissions.
   Evidence: Any JSON body over 16,384 bytes is rejected before validation. For example, 17,000 spaces followed by `{"input":"hello"}` is valid JSON and satisfies every specified payload rule, but this branch returns `400 invalid_request`.
   Fix: Remove the additional rejection condition or implement parsing that accommodates JSON whitespace while enforcing the specified field limits.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
