A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [blocker] ui/index.html:36 — Invalid JavaScript disables the entire browser UI.
   Evidence: Parsing the inline script produces `SyntaxError: Invalid left-hand side in assignment`. Assignments such as `item.dataset-testid = 'job-item'` are invalid; the same error appears for status, progress, and result. Consequently, submission handlers and automatic refresh never initialize.
   Fix: Replace all four assignments with `element.dataset.testid = '...'` or `element.setAttribute('data-testid', '...')`.

2. [major] src/server.ts:17 — Request decoding can corrupt submitted Unicode text.
   Evidence: Each incoming buffer is independently decoded with `chunk.toString()`. Calling the handler with valid JSON containing `café`, split between the two UTF-8 bytes of `é`, returned `201` with input `caf��`. This violates exact input preservation and can also cause incorrect idempotency conflicts.
   Fix: Decode using a streaming UTF-8 decoder, set the request encoding to UTF-8 before reading, or concatenate buffers before decoding.

3. [major] ui/index.html:18 — Native form validation prevents invalid values from reaching API validation.
   Evidence: The form has no `novalidate`, while its fields have `required`, `min`, `max`, and implicit integer-step constraints. Even after fixing the script, submitting an empty input, steps `21`, or fractional steps is blocked before the submit handler runs, so the API cannot provide the required field errors in `form-error`.
   Fix: Add `novalidate` to the form so submissions reach the API and its rejection details populate the alert.

4. [minor] src/server.ts:26 — Unsupported methods on `/` return the wrong status and error code.
   Evidence: Calling the handler with `POST /` returns `404 not_found`. `/` is a known path, so the required response is `405 method_not_allowed`.
   Fix: Handle `/` independently of the method, serving HTML for GET and returning the standard 405 JSON error otherwise.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
