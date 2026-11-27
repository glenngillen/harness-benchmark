# Review findings

1. [major] src/worker.ts:15 — Restart recovery bypasses the three-attempt limit and can complete a job that must fail.
   Evidence: Recovery requeues every running job, and claiming increments its attempts unconditionally. Running the worker logic against an in-memory restart fixture with `status: "running"`, `attempts: 3`, and `failAttempts: 3` produced `status: "completed"`, `attempts: 4`, and output `"HELLO"`. This state can occur when SIGKILL interrupts the third attempt before its failure is persisted.
   Fix: Handle exhausted attempts during recovery and enforce the attempt limit before claiming. An interrupted third attempt with `failAttempts >= 3` must end failed with `"transient failure"` and `attempts: 3`.

2. [major] src/server.ts:68 — Storing input directly as SQLite TEXT corrupts valid JavaScript strings.
   Evidence: With the supplied Node version, a SQLite TEXT round trip changes `"a\u0000b"` to `"a"` and `"a\ud800b"` to `"a�b"`. Both inputs pass validation. The server immediately reads back this altered input, and the worker uppercases it, violating exact input preservation and the required output.
   Fix: Store input and result using a lossless representation, such as JSON-encoded strings, and decode consistently when returning jobs and processing input. Verify embedded NUL characters and lone surrogates survive submission, processing, and restart.