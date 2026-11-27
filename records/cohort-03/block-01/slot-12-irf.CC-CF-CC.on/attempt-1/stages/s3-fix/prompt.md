A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:13 — Restarting during the third attempt permanently fails jobs that should succeed.
   Evidence: Startup marks every `running` job with `attempts >= 3` as failed with `"transient failure"`, without checking whether a transient failure occurred. A job with `failAttempts: 2` interrupted during its successful third attempt is therefore never processed again, contrary to the restart requirement.
   Fix: Recover interrupted processing rather than treating interruption as a dependency failure. Preserve enough state to resume or replay the interrupted final attempt, and mark it failed only when the transient-failure rule actually applies.

2. [major] src/server.ts:20 — Request chunk boundaries can corrupt valid Unicode input.
   Evidence: Each buffer is decoded separately with `chunk.toString()`. Calling the handler with valid JSON containing `é`, split between its two UTF-8 bytes, returned `201` with `input: "��"`. This violates exact input preservation and can also cause incorrect validation, output, and idempotency comparisons.
   Fix: Accumulate buffers and decode once with `Buffer.concat(...).toString('utf8')`, or use a streaming UTF-8 decoder.

3. [major] src/server.ts:42 — An unknown request path can terminate the server.
   Evidence: The URL constructor is outside any error handler. A request target of `//[` causes `new URL()` to throw `TypeError: Invalid URL`, confirmed by invoking the request handler. Because the HTTP listener is async and its rejected promise is unhandled, this can terminate Node instead of returning the required JSON `404`.
   Fix: Guard URL parsing and return a structured JSON error for unparseable paths. Also catch unexpected failures at the request-handler boundary so malformed requests cannot terminate the process.

4. [minor] ui/index.html:20 — Native form validation prevents invalid values from reaching API validation.
   Evidence: The form uses `required`, `maxlength`, and numeric `min`/`max` constraints without `novalidate`. For example, submitting steps `21` or `1.5` is blocked before the submit handler runs, so no API request occurs and `form-error` does not show the offending field as required.
   Fix: Add `novalidate` to the form and remove input restrictions that prevent submitting the entered value, such as `maxlength`. Keep numeric conversion in the submit handler and display the API’s validation errors in `form-error`.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
