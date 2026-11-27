# Review findings

1. [major] src/db.ts:147 — Restart recovery erases processing attempts that already started.
   Evidence: `recoverInterruptedJobs()` decrements `attempts`, and graceful shutdown does the same through `requeueJob(..., false)` at src/worker.ts:54. An in-memory reproduction showed the first claim reporting 1, recovery resetting it to 0, and the second claim reporting 1 again. This violates the definition of `attempts` as the number of processing attempts started so far and loses durable job history.
   Fix: Preserve `attempts` when requeuing interrupted jobs, both during startup recovery and graceful shutdown. Increment it when processing starts again, and ensure retry decisions use the preserved attempt count.