A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:27 — Crash recovery can exceed the three-attempt limit and incorrectly complete jobs that should fail.
   Evidence: In an in-memory reproduction, recovering a `running` job with `attempts: 3` and `failAttempts: 3` caused `claimNext` to start attempt 4. The job then completed with output because attempt 4 bypassed the simulated failure condition.
   Fix: Make recovery enforce the attempt budget and preserve the required terminal outcome. Add coverage for interruption during the third attempt with `failAttempts: 3` and higher.

2. [major] src/worker.ts:53 — Graceful shutdown erases an attempt that already started.
   Evidence: `revertAttempt` decrements `attempts`. Claiming a new job and invoking this shutdown path changes its count from 1 back to 0, although the contract defines `attempts` as the number of processing attempts started. Restarting therefore repeats the same attempt number.
   Fix: Preserve the count of started attempts when requeuing interrupted work, and coordinate recovery with the three-attempt limit.

3. [minor] src/server.ts:166 — Unsupported HEAD requests return success instead of 405.
   Evidence: The handler rewrites `HEAD` to `GET`. Direct handler checks returned 200 for `HEAD /health`, `HEAD /api/jobs`, and `HEAD /`, whereas the task requires `405 method_not_allowed` for wrong methods on known paths.
   Fix: Route using the original request method and reject methods other than those specified.

4. [minor] src/server.ts:85 — Early validation returns omit independently invalid fields.
   Evidence: A malformed JSON body with `Idempotency-Key: bad key` reports only `"body"`, omitting `"Idempotency-Key"`. A non-JSON content type likewise bypasses header validation. The contract requires each offending field in `fields`.
   Fix: Validate the idempotency header independently and accumulate its error alongside body errors before returning the rejection.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
