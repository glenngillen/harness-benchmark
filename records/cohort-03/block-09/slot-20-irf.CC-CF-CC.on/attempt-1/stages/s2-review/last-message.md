# Review findings

1. [major] src/worker.ts:11 — Restarting the worker incorrectly fails an interrupted successful third attempt.
   Evidence: Startup requeues running jobs, then immediately marks every queued job with `attempts >= 3` as failed. Executing this startup code against an in-memory job with `failAttempts: 2`, `attempts: 3`, and progress `5/20` produced `"failed"` with `"transient failure"`. That attempt should succeed; killing the worker during it must not invent a third transient failure.
   Fix: Distinguish interrupted processing from an actual simulated failure. Recover interrupted work so it can complete, and assign terminal `"transient failure"` only when the retry rules actually produce that failure.

2. [minor] ui/index.html:24 — Native browser validation prevents fractional numeric submissions from reaching the API.
   Evidence: Both number inputs have the default integer step constraint, and the form lacks `novalidate`. Entering `steps: 1.5` or `failAttempts: 0.5` blocks the submit event, so no API request occurs and `form-error` does not display the offending field as required.
   Fix: Add `novalidate` to the form so these values reach the existing submit handler and API validation, which can populate the required error region.