A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:30 — Restarting during the third attempt incorrectly fails a recoverable job.
   Evidence: Startup requeues running jobs, but the processing loop immediately fails any job with `attempts >= 3`. An in-memory reproduction with `failAttempts: 2`, `attempts: 3`, and partial progress became `failed` with `"transient failure"` without processing another step. That third attempt should succeed, and interrupted jobs must be processed again.
   Fix: Distinguish interrupted attempts from transient failures and replay the unfinished attempt on recovery, including attempt 3. Only terminally fail after the specified transient failure actually occurs.

2. [major] src/db.ts:37 — SQLite text storage does not preserve all accepted JavaScript strings.
   Evidence: Using the application's database helpers, storing `"a\u0000b"` returned `"a"`, and storing `"a\ud800b"` returned `"a�b"`. Both inputs pass validation. This violates exact input preservation and also changes the worker's uppercase output.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode them when constructing job responses and processing input.

3. [minor] ui/index.html:18 — Native form validation prevents invalid values from reaching the API.
   Evidence: The form lacks `novalidate`, while its fields impose `required`, range, and integer constraints. Submitting empty input, `steps: 21`, or fractional steps therefore prevents the submit handler from running; the API cannot validate these submissions, and `form-error` does not display their offending field names.
   Fix: Add `novalidate` to the form so submissions reach the existing API validation and error-rendering handler.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
