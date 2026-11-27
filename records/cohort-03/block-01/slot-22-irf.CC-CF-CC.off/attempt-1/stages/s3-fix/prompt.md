A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/server.ts:29 — A malformed request path can terminate the server.
   Evidence: Calling the request handler with `//[/` produces an unhandled `Invalid URL` rejection because URL parsing happens outside the `try`. Node’s HTTP server does not catch rejected async handlers, so one request can crash the process instead of receiving a JSON error.
   Fix: Move parsing inside the error boundary and handle invalid request targets explicitly.

2. [major] ui/index.html:27 — Browser validation prevents invalid submissions from reaching the API.
   Evidence: The form uses `required`, `min`, and `max` constraints without `novalidate`. Submitting `steps: 0`, `steps: 1.5`, or an empty input suppresses the submit event, so no API request occurs and `form-error` does not show the required field-specific rejection.
   Fix: Add `novalidate` to the form so submissions reach the existing API validation and error-rendering logic.

3. [minor] src/server.ts:99 — A newly created job can be returned as `running` instead of `queued`.
   Evidence: The creation transaction commits before `getJob()` reads the response. The separate worker can claim the job between those operations, causing the `201` response to contain `running` and `attempts: 1`, contrary to the required creation response.
   Fix: Read and retain the new job inside the transaction, then commit and return that snapshot.

4. [minor] src/server.ts:50 — Early validation returns omit independently invalid header fields.
   Evidence: A direct handler check with `Content-Type: text/plain` and `Idempotency-Key: bad!` returned only `body` in `fields`. Malformed JSON similarly bypasses idempotency-key validation. The contract requires each offending field to be listed.
   Fix: Validate the idempotency header before body-related early returns and include its error alongside any body error.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
