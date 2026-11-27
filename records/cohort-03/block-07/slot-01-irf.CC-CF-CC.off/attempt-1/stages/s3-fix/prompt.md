A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/server.ts:20 — Request chunks are decoded independently, corrupting valid Unicode input.
   Evidence: An in-memory request-handler check split the UTF-8 bytes of `{"input":"é"}` across two chunks. The API returned `201` with `"input":"��"`. HTTP chunk boundaries can occur inside a character, violating exact input preservation and potentially breaking idempotent replays.
   Fix: Decode the stream with `req.setEncoding('utf8')`, use `StringDecoder`, or concatenate buffers before decoding.

2. [major] src/worker.ts:9 — Restart recovery can exceed the three-attempt limit and complete a job that should fail.
   Evidence: Recovery unconditionally requeues running jobs, then increments attempts again. Testing a persisted `running` job with `attempts: 3` and `failAttempts: 3` produced `completed`, `attempts: 4`, and output `"HELLO"`. This state can occur if the worker is killed after claiming its third attempt but before recording the simulated failure.
   Fix: Handle exhausted attempts during recovery and enforce the retry limit before claiming another attempt. An interrupted third attempt that must fail transiently should become `failed` with `attempts: 3` and `"transient failure"`.

3. [major] ui/index.html:20 — Native form validation prevents invalid submissions from reaching the API.
   Evidence: The form has no `novalidate`, while its inputs have `required`, `min`, `max`, and integer `step` constraints. Submitting empty input, `steps: 21`, or fractional steps prevents the submit handler from running, so no API request occurs and `form-error` does not display the required field-specific rejection.
   Fix: Add `novalidate` to the form so the existing submit handler sends the values and renders the API’s validation response.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
