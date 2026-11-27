A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:10 — Restart recovery can exceed the three-attempt limit and complete a job that should fail.
   Evidence: Recovery unconditionally requeues running jobs, and claiming increments attempts again. Executing the worker with a recovered `running` job having `attempts: 3` and `failAttempts: 3` produced `completed`, `attempts: 4`, and output `"HELLO"`. This state can arise when the worker stops during the third attempt’s initial delay.
   Fix: Make recovery respect the attempt limit. A recovered job whose third attempt must transiently fail should become `failed` with `"transient failure"` and attempts remaining 3.

2. [major] src/server.ts:23 — Request decoding corrupts Unicode characters split across HTTP chunks.
   Evidence: The handler decodes each buffer separately with `chunk.toString()`. Passing valid JSON containing `"é"` with its UTF-8 bytes split across two chunks returned `201` with input `"��"`. This violates exact input preservation and can also break idempotency comparisons.
   Fix: Collect buffers and decode once with `Buffer.concat(...).toString('utf8')`, or use streaming UTF-8 decoding.

3. [major] ui/index.html:18 — Browser validation prevents invalid form submissions from reaching the API.
   Evidence: The form has native validation enabled, with `required`, `maxlength`, numeric bounds, and the default integer step constraint. Submitting steps `21` or `1.5`, for example, prevents the submit handler from running, so the API’s field-specific rejection never appears in `form-error`.
   Fix: Add `novalidate` to the form so its handler submits the values and displays API validation errors.

4. [minor] src/server.ts:97 — Unknown nested paths return 405 for non-GET requests.
   Evidence: Directly invoking the handler for `POST /api/jobs/foo/bar` returned `405 method_not_allowed`. This path matches no endpoint and must return `404 not_found`. The method check runs before checking whether the suffix is a valid single path segment.
   Fix: Validate the route shape before checking its method; return 405 only for paths matching a defined endpoint.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
