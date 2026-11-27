# Review findings

1. [blocker] ui/index.html:40 — A syntax error disables the entire browser application.
   Evidence: `item.dataset-testid = 'job-item'` produces `SyntaxError: Invalid left-hand side in assignment` when parsing the inline script. Consequently, submission handlers and polling never run.
   Fix: Change this assignment to `item.dataset.testid = 'job-item'` and verify browser submission and live job updates.

2. [major] src/worker.ts:9 — Restart recovery bypasses the three-attempt limit and can complete a job that must fail.
   Evidence: Running the worker against an in-memory database containing a recovered `running` job with `attempts: 3` and `failAttempts: 3` produced `status: "completed"` and `attempts: 4`. Recovery queues the job unconditionally, and claiming increments attempts before checking simulated failure.
   Fix: Enforce the attempt limit during recovery and claiming. A recovered third attempt that must fail should become `failed` with `"transient failure"` and `attempts: 3`, rather than starting attempt four.

3. [major] src/server.ts:20 — Request decoding corrupts Unicode characters split across incoming chunks.
   Evidence: Executing `readBody` with valid JSON containing `café`, split between the two UTF-8 bytes of `é`, returned `{"input":"caf��"}`. This changes stored input and its eventual output, violating exact input preservation.
   Fix: Decode through a streaming UTF-8 decoder, use `req.setEncoding('utf8')`, or concatenate buffers before decoding.

4. [major] ui/index.html:21 — Native form validation prevents invalid numeric values from reaching API validation.
   Evidence: The form lacks `novalidate`, while numeric fields impose `min`, `max`, and the default integer step constraint. Submitting values such as `steps: 21` or `steps: 1.5` is blocked before the submit handler runs, so no API rejection or offending field name appears in `form-error`. This remains after fixing the script syntax.
   Fix: Add `novalidate` to the form so submissions reach the API and its validation errors populate the required alert region.