# Review findings

1. [major] src/worker.ts:24 — Restart recovery erases attempts that already started.
   Evidence: Recovery subtracts one from `attempts` before requeuing every running job. If attempt 1 is interrupted, restarting and completing the job reports only 1 attempt despite two processing attempts having started. Repeated restarts also allow repeated execution under the same attempt number, contrary to the defined counter and retry limit.
   Fix: Preserve the durable count of attempts started during recovery. Ensure recovery and retry logic consistently enforce attempt numbering and the three-attempt limit.

2. [major] src/server.ts:151 — SQLite TEXT storage does not preserve every valid JavaScript input string.
   Evidence: An in-memory test using the installed Node.js SQLite implementation round-tripped `"a\u0000b"` as `"a"` and `"a\ud800b"` as `"a�b"`. Both inputs pass this application's validation. Since the server and worker read the input directly from TEXT, submitted input changes and the worker produces the wrong output.
   Fix: Store input and output in a lossless representation, such as JSON-encoded strings, and decode them when processing and returning jobs. Verify embedded NULs and lone surrogate code units round-trip exactly.

3. [major] src/server.ts:151 — Job creation can return a running job instead of the required queued job.
   Evidence: The INSERT commits before the separate `selectById.get` call. The independent worker can claim that row between these statements, causing the `201` response to contain `status: "running"` and `attempts: 1`. Synchronous server calls do not prevent another process from updating SQLite.
   Fix: Capture the newly inserted row atomically with `INSERT ... RETURNING *`, or read it within the same write transaction, and use that queued snapshot for the creation response.