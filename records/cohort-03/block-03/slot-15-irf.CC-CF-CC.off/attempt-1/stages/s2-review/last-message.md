# Review findings

1. [major] src/worker.ts:10 — Restart recovery permanently fails interrupted successful attempts.
   Evidence: A job with `failAttempts: 2` that is killed while processing attempt 3 is first requeued, then immediately marked `failed` with `"transient failure"`. Executing the recovery SQL against this state confirmed that result. Its third attempt did not encounter a simulated failure, and the requirement says interrupted running jobs must be processed again.
   Fix: Distinguish interrupted processing from exhausted transient failures. Recover and process interrupted jobs without assigning a terminal transient failure solely because `attempts >= 3`.

2. [major] ui/index.html:13 — Native form validation prevents invalid values from reaching the API.
   Evidence: The form lacks `novalidate`, while its fields have `required`, `min`, `max`, and `step` constraints. Submitting an empty input, `steps: 21`, or fractional steps is blocked before the submit handler runs, so no API request occurs and `form-error` does not show the offending fields. The task requires form submissions to use API validation.
   Fix: Add `novalidate` to the form and allow invalid field values to reach the existing submission handler, retaining numeric conversion and rendering the API’s validation errors.

3. [minor] src/server.ts:61 — An invalid idempotency key suppresses all body validation errors.
   Evidence: Calling the request handler with `Idempotency-Key: bad!` and `{"input":"","steps":"3","extra":true}` returned a `fields` array containing only `Idempotency-Key`. The `if (!fields.length)` guard skips JSON parsing when header validation has already failed, omitting the required `input`, `steps`, and `extra` errors.
   Fix: Parse and validate a readable JSON body independently of header validation, then combine all offending fields in the response.