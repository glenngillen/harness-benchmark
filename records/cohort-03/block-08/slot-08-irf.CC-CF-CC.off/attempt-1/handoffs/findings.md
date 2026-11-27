# Review findings

1. [major] src/worker.ts:14 — Restart recovery can bypass the three-attempt limit and complete a job that must fail.
   Evidence: Recovery requeues every running job, then increments its attempt count. Executing this path against an in-memory row with `status='running'`, `attempts=3`, and `failAttempts=3` produced `completed`, `attempts=4`, and output `"HELLO"`. This state can arise when the worker is killed during the third attempt.
   Fix: Make recovery account for interrupted attempts and enforce terminal failure at the retry limit. A restart must not let `failAttempts >= 3` escape the required failure outcome.

2. [major] src/server.ts:15 — Request decoding corrupts valid Unicode input when a character spans chunks.
   Evidence: Passing the valid JSON body `{"input":"café"}` in two buffers split inside `é` returned `201` with input `"caf��"`. Each buffer is decoded independently, violating the requirement to store input exactly as submitted and potentially changing idempotency comparisons.
   Fix: Concatenate byte buffers before decoding, or use a streaming UTF-8 decoder.

3. [major] src/server.ts:75 — An invalid percent-encoded job ID can terminate the server.
   Evidence: Calling the request handler with `GET /api/jobs/%ZZ` rejects with `URIError: URI malformed`. The async HTTP handler has no rejection boundary, so Node treats this as an unhandled rejection instead of returning the required JSON error.
   Fix: Catch URI decoding failures and return a JSON `404 not_found` for an unmatched ID. Add a request-level error boundary so exceptions cannot terminate the process.

4. [major] ui/index.html:17 — Native form validation prevents invalid values from reaching the API and displaying field errors.
   Evidence: The form has no `novalidate`, while its inputs specify `required`, `min`, and `max`. Submitting an empty input, `steps=21`, or `failAttempts=6` is blocked before the submit handler runs, leaving `form-error` empty instead of showing the API’s rejection.
   Fix: Add `novalidate` to the form so submissions reach the existing API validation and render offending field names in `form-error`.