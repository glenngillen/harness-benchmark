# Review findings

1. [major] src/server.ts:102 — SQLite text storage does not preserve every valid JavaScript input string.
   Evidence: Exercising the request handler with `{"input":"a\u0000b"}` returned `201` with `"input":"a"`. An identical replay with the same key returned `409`. An unpaired surrogate was likewise replaced. These inputs pass the specified validation, but their stored representation breaks exact input preservation, uppercase output, and idempotency.
   Fix: Encode input and output losslessly before storage, such as with JSON string encoding, and decode them before processing, comparison, and API serialization.

2. [major] src/worker.ts:24 — Restart recovery can exceed the three-attempt limit and incorrectly complete a job that should fail.
   Evidence: Recovery requeues every running job without checking its attempt count, and claiming it increments that count again. Exercising recovery with a running job at `attempts: 3`, `failAttempts: 3` produced `completed`, `attempts: 4`, and an output. This state can arise if the worker is killed after claiming its third attempt but before recording the transient failure.
   Fix: Make recovery respect the attempt budget and preserve the third attempt’s required failure outcome. Never start an additional retry after the three permitted attempts.

3. [major] src/server.ts:109 — Creating a job can return its worker-updated state instead of the required queued state.
   Evidence: The insert commits before a separate `SELECT` retrieves the response. The independent worker can claim the new row between these statements, causing a `201` response with `status: "running"` and `attempts: 1`; an immediately failing attempt can also change the row before it is returned.
   Fix: Capture the initial row atomically with `INSERT ... RETURNING *`, or keep insertion and response-row retrieval in one transaction so the worker cannot update it between them.