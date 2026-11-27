All four findings were correct, and I fixed all of them. The build passes, `check:smoke` passes 2/2, and `check:contract` passes 5/5.

**Changes**

- **Finding 1 (attempt accounting), option (a):** An interrupted attempt is no longer counted. `requeueRunning` now does `attempts = MAX(attempts - 1, 0)`, so the rerun reuses that attempt number. I chose this over option (b) because the spec says an interrupted job is "processed again", and counting the interrupted attempt would wrongly fail a job that was never tested. `runAttempt` also has a guard: if a job would start attempt 4, it is marked `failed` instead.
- **Finding 2 (stuck `running` rows):** The worker sets a `needsRecovery` flag at startup and after any error in the loop. When the flag is set, the loop runs the requeue before picking the next job. Because the loop is sequential, no attempt is in flight at that point, so any `running` row is stale. A failed DB write therefore can no longer leave a job stuck.
- **Finding 3 (UI number parsing):** `fieldValue` now converts only plain decimal numbers (`/^-?\d+(\.\d+)?$/`). Anything else, such as `0x10` or `1e1`, is sent as a string so the API rejects it and names the field.
- **Finding 4 (failure lost on stop):** A failing first-step attempt now records its failure or retry before checking `stopping`.

**Verified**

- A job with `failAttempts: 0` and 20 steps was killed with SIGKILL three times mid-run. Its `attempts` stayed at 1 on every restart, and it completed with `attempts: 1`.
- A job with `failAttempts: 5` ends `failed` with `attempts: 3`.
- Both processes exit on SIGTERM.

Nothing is committed.