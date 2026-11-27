# Review findings

1. [major] src/worker.ts:10 — Restart recovery can exceed three attempts and complete a job that must fail.
   Evidence: Recovery requeues every running job, and claiming it increments attempts unconditionally. Running the worker logic against an in-memory crash snapshot with `status="running"`, `attempts=3`, and `failAttempts=3` produced `status="completed"`, `attempts=4`, and output `"HELLO"`. This state can occur when the worker is killed just after starting attempt 3.
   Fix: Handle exhausted attempts during recovery so jobs with `failAttempts >= 3` finish failed with `"transient failure"` and `attempts=3`, without starting attempt 4.

2. [major] ui/index.html:18 — Native form validation prevents invalid values from reaching the API.
   Evidence: The form lacks `novalidate`, while its inputs use `required`, range constraints, and the default integer step. Submitting an empty input or steps `0`, `21`, or `1.5` therefore never invokes the submit handler, sends no API request, and leaves `form-error` empty instead of displaying the API’s field errors.
   Fix: Disable native submission validation and allow the handler to send entered values to the API, preserving numeric conversion and rendering its rejection.

3. [minor] src/server.ts:67 — An invalid idempotency key hides other offending fields.
   Evidence: Directly invoking the request handler with key `bad!` and body `{"input":" ","steps":"3","extra":true}` returned only `Idempotency-Key` in `error.fields`. The required `input`, `steps`, and `extra` errors were omitted because the handler returns before payload validation.
   Fix: Aggregate header errors and all applicable body-validation errors before returning `400`. Also collect independently detectable header errors when Content-Type is invalid.

4. [minor] src/server.ts:87 — The creation response can contain a running job instead of the required queued job.
   Evidence: The server commits the insertion before selecting the job for its `201` response. The separate worker can claim it between those operations, causing the response to contain `status="running"` and `attempts=1`.
   Fix: Capture the inserted job representation inside the transaction before committing, then return that queued snapshot after a successful commit.