A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/server.ts:65 — SQLite text storage corrupts some valid inputs, breaking exact preservation, output, and idempotency.
   Evidence: An in-memory check using the repository’s database functions on Node 22.23.4 stored `"ab\u0000cd"` but returned `"ab"`; `"a\ud800b"` returned `"a�b"`. Both inputs pass validation. The worker therefore processes altered input, and replaying the original payload with the same key produces a conflict because the stored input differs.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode consistently for processing, API responses, and idempotency comparisons. Test embedded NULs and lone surrogates.

2. [major] src/worker.ts:38 — Recovery decrements the number of attempts already started.
   Evidence: Both `requeueInterrupted` and `recoverRunning` subtract one from `attempts`. A job interrupted during attempt 1 is subsequently claimed as attempt 1 again, despite two processing attempts having started. Repeated restarts can repeatedly reuse the same attempt number, contrary to the defined attempt count and retry budget.
   Fix: Preserve the durable count when requeuing interrupted work, count each newly started attempt, and handle recovery at the attempt limit explicitly without resetting the counter.

3. [minor] src/server.ts:41 — The undocumented 16 KiB body limit rejects otherwise valid submissions.
   Evidence: A JSON body consisting of 17,000 spaces followed by `{"input":"a"}` satisfies the specified validation rules, but `readBody` discards it and returns `400 invalid_request`. The contract limits the parsed input length, not the serialized request size.
   Fix: Remove the additional body-size restriction or implement parsing that accepts contract-valid payloads regardless of insignificant JSON whitespace.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
