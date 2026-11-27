# Review findings

1. [blocker] ui/index.html:37 — A JavaScript syntax error disables the entire browser UI.
   Evidence: `item.dataset-testid = 'job-item'` produces `SyntaxError: Invalid left-hand side in assignment`. The script never installs the submission handler or starts polling.
   Fix: Change the assignment to `item.dataset.testid = 'job-item'` and verify that the browser can submit jobs and display progress.

2. [major] src/worker.ts:8 — Restart recovery can exceed three attempts and incorrectly complete a job that should fail.
   Evidence: Running the worker logic against an in-memory row interrupted during attempt 3 with `failAttempts: 3` produced `status: "completed"`, `attempts: 4`, and output `"HELLO"`. Recovery requeues the row, claim increments attempts unconditionally, and attempt 4 bypasses the simulated failure.
   Fix: Enforce the attempt limit during recovery and claiming. An interrupted third attempt that must transiently fail should become `failed` with `attempts: 3` and `"transient failure"`, never start attempt 4.

3. [major] src/server.ts:18 — Request decoding corrupts Unicode characters split across incoming chunks.
   Evidence: Invoking the request handler with valid JSON containing `é`, split between its UTF-8 bytes, returned `201` with input `"��"`. Each chunk is decoded independently, violating exact input preservation and affecting output and idempotency comparisons.
   Fix: Use a streaming UTF-8 decoder, `req.setEncoding('utf8')`, or concatenate buffers before decoding.

4. [major] ui/index.html:18 — Native form validation prevents invalid values from reaching API validation.
   Evidence: The form has `required`, `min`, `max`, and implicit integer-step constraints without `novalidate`. Empty input, steps `0`, or fractional steps prevent the submit handler from running, so the API rejection and offending field names cannot appear in `form-error`.
   Fix: Add `novalidate` to the form so submissions reach the API and its validation errors populate the alert.

5. [minor] src/server.ts:27 — Wrong methods on `/` return 404 instead of 405.
   Evidence: Invoking the handler with `POST /` returned `404 not_found`; the root route only matches GET and otherwise falls through to the unknown-path response.
   Fix: Match `/` independently of the method and return `405 method_not_allowed` for unsupported methods.