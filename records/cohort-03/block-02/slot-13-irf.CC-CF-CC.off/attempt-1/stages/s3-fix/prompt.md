A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:56 — Successful submissions incorrectly display “Unable to submit job.”
   Evidence: The success branch accesses `event.currentTarget` after awaiting the HTTP response. Browsers clear `currentTarget` after event dispatch, so `.reset()` throws and the catch block displays an error despite the job being created. Executing the handler with a successful mocked response and browser-equivalent event cleanup reproduced this.
   Fix: Save the form element before the first `await` and use that reference for both `FormData` and `reset()`.

2. [major] src/worker.ts:10 — Restart recovery erases processing attempts.
   Evidence: Both startup recovery and graceful shutdown (line 67) decrement `attempts` for interrupted running jobs. A job interrupted during attempt 1 starts processing again with `attempts: 1`, although two attempts have started. Repeated interruptions can indefinitely replay the same simulated failure without reaching the three-attempt limit.
   Fix: Preserve the durable attempt count when recovering interrupted work. Count each newly started attempt and enforce the retry limit consistently during recovery.

3. [major] ui/index.html:19 — Native form validation prevents invalid values from reaching the API.
   Evidence: The form lacks `novalidate`, and its inputs have `required`, range constraints, and the default integer step constraint. Submitting values such as `steps: 0`, `steps: 1.5`, or `failAttempts: 6` never triggers the submit handler, so no API request occurs and `form-error` does not show the offending field as required.
   Fix: Add `novalidate` to the form so submissions reach the existing API validation and its field errors appear in `form-error`.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
