A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/jobs.ts:105 — SQLite text round-tripping corrupts valid inputs.
   Evidence: Calling `insertJob` against an in-memory database with `"a\u0000b"` returns input `"a"`; an unpaired surrogate `"\ud800"` returns `"�"`. Both pass validation. The worker processes this corrupted input, so the submitted text and resulting uppercase output violate the contract.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode them when reading. Verify embedded NULs and unpaired surrogates survive submission, processing, and retrieval.

2. [major] src/jobs.ts:112 — Restart recovery permits attempts beyond the three-attempt limit.
   Evidence: I simulated two transient failures followed by an interrupted third attempt. `requeueInterrupted` followed by `claimNext` returned a running job with `attempts: 4`. Recovery unconditionally requeues running jobs, and claiming unconditionally increments attempts.
   Fix: Make recovery respect the attempt budget. Recover an interrupted final attempt without starting a fourth attempt, and ensure interrupted transient failures cannot bypass the required terminal failure behavior.

3. [minor] ui/index.html:55 — Valid numeric field values can be submitted as strings.
   Evidence: The conversion regex rejects exponent notation such as `1e1`, which is valid in an HTML number input and represents the valid steps value 10. The form sends `"1e1"` as a string, causing the API to reject it.
   Fix: Convert nonempty valid number-input values using `valueAsNumber` or `Number`, while preserving API rejection of invalid values.

4. [minor] src/server.ts:119 — An undocumented body-size limit rejects otherwise valid submissions.
   Evidence: `{"input":"hello"}` followed by 17,000 spaces is valid JSON satisfying every specified validation rule, but the 16 KiB check returns `400 invalid_request`.
   Fix: Remove the extra request-size restriction so valid JSON whitespace and formatting do not change whether a conforming payload is accepted.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
