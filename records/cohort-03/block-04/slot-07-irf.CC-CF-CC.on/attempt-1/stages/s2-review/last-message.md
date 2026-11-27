# Review findings

1. [major] src/worker.ts:25 — Restarted processing attempts are not counted.
   Evidence: Startup marks interrupted jobs with `recovery=1`, and claiming them adds zero to `attempts`. A job killed during attempt 1 restarts processing from step zero and completes with `attempts: 1`, despite having started twice. This contradicts the required attempt counter and permits repeated restarts without consuming attempts.
   Fix: Count recovered processing starts as attempts, and handle recovery at the attempt limit explicitly so the three-attempt maximum is preserved.

2. [major] ui/index.html:27 — Native form validation prevents invalid numeric submissions from reaching the API.
   Evidence: The numeric fields have `min`, `max`, and `step` constraints, but the form lacks `novalidate`. Entering `steps=0`, `steps=1.5`, or `failAttempts=6` blocks the submit event before the fetch handler runs. Consequently, the API cannot validate these submissions and `form-error` does not display the offending field names.
   Fix: Add `novalidate` to the form so submissions reach the existing API validation and error-rendering handler.