# Review findings

1. [blocker] ui/index.html:58 — A JavaScript syntax error disables the entire browser UI.
   Evidence: `item.dataset-testid = 'job-item'` produces `SyntaxError: Invalid left-hand side in assignment`, confirmed by extracting the script and running `node --check`. No submission handler or polling runs.
   Fix: Change the assignment to `item.dataset.testid = 'job-item'` and verify the page can submit jobs and render updates.

2. [major] src/worker.ts:10 — Restarting during the third attempt can bypass the retry limit and complete a job that must fail.
   Evidence: Startup requeues every running job, and claiming increments attempts unconditionally. Executing the worker against an in-memory database containing an interrupted third attempt with `failAttempts: 3` produced `status: completed`, `attempts: 4`, and output `HELLO`.
   Fix: Make recovery enforce the three-attempt failure limit. An interrupted third attempt that is destined to fail must become `failed` with `"transient failure"` and `attempts: 3`, rather than starting attempt four.

3. [major] ui/index.html:21 — Native form validation prevents invalid values from reaching the API and its required error region.
   Evidence: The form uses `required`, `min`, `max`, and `step` constraints without `novalidate`. Even after fixing the script, submitting an empty input, steps of 21, or fractional steps prevents the submit handler from running, so the API cannot return field errors for display.
   Fix: Add `novalidate` to the form so submissions reach the API, retaining numeric conversion and displaying every returned field error.

4. [minor] src/server.ts:98 — Creating a job can return a running job instead of the required queued representation.
   Evidence: The insertion transaction commits before the server selects the job for its `201` response. The separate worker can claim it between those operations, causing the response to contain `status: running` and `attempts: 1`.
   Fix: Read or construct the initial queued representation before committing, then send that captured representation after the commit succeeds.