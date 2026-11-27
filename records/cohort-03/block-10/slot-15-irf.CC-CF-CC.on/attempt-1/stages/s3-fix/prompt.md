A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:10 — Restart recovery can bypass the three-attempt limit and complete a job that must fail.
   Evidence: Recovery requeues every running job, and `claim()` unconditionally increments attempts. Executing this logic against an in-memory row interrupted on attempt 3 with `failAttempts: 3` produced `status: "completed"`, `attempts: 4`, and output `"HELLO"`. Killing or stopping the worker during the third attempt can therefore change the required outcome.
   Fix: Enforce the attempt limit during recovery and claiming. An interrupted third attempt subject to the simulated transient failure must become failed with `"transient failure"` rather than starting attempt 4.

2. [major] src/server.ts:20 — Request decoding corrupts Unicode characters split across incoming chunks.
   Evidence: The handler converts each buffer independently with `chunk.toString()`. An in-memory request containing `{"input":"é"}`, split between the character’s UTF-8 bytes, returned `201` with input `"��"`. Replaying the identical payload unsplit with the same key returned `409`. This violates exact input storage and idempotency.
   Fix: Decode the request using `req.setEncoding('utf8')`, a streaming decoder, or concatenate buffers before converting to text.

3. [major] ui/index.html:17 — Native form validation prevents invalid values from reaching API validation.
   Evidence: The form lacks `novalidate`, while its inputs impose `required`, `min`, `max`, and the number input’s default integer step constraint. Submitting an empty input, steps `21`, or steps `1.5` prevents the submit handler from running, so no POST occurs and `form-error` does not show the API rejection or offending fields.
   Fix: Add `novalidate` to the form so submissions reach the existing API validation and error-rendering handler.

4. [minor] src/server.ts:65 — Invalid headers short-circuit validation and omit other offending fields.
   Evidence: An in-memory request with `Idempotency-Key: invalid!` and body `{"input":3,"steps":0,"extra":1}` returned only `"Idempotency-Key"` in `fields`, omitting `input`, `steps`, and `extra`. The contract requires each offending field to be listed.
   Fix: Accumulate header and body validation errors, then return a single `invalid_request` response containing all applicable fields.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
