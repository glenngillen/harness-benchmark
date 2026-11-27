# Review findings

1. [major] src/worker.ts:40 — Restart recovery erases processing attempts that already started.
   Evidence: An in-memory check of the worker functions showed a running job with `attempts: 1` becoming queued with `attempts: 0`, then reporting `attempts: 1` when its second attempt started. Graceful shutdown does the same at line 93. This violates the defined attempt count and allows interruptions to repeatedly reuse an attempt number.
   Fix: Preserve the attempt count during recovery and shutdown. Increment it when another attempt starts, and apply the retry limit consistently to interrupted jobs.

2. [major] src/server.ts:124 — Creating a job can return `running` instead of the required `queued` representation.
   Evidence: `createJob()` commits the insertion before calling `getJobRow(id)`. The separate worker can claim the job between those operations, so the `201` response can contain `status: "running"` and `attempts: 1`.
   Fix: Read and retain the newly inserted job inside the transaction, before committing, then return that snapshot after the commit succeeds.