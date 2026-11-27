# Review findings

1. [major] src/worker.ts:29 — Restart recovery can exceed the three-attempt limit and complete a job that should fail.
   Evidence: Recovery requeues every running job, and claiming increments its attempt count again. Running the worker against an in-memory job with `status: "running"`, `attempts: 3`, and `failAttempts: 3` produced `status: "completed"`, `attempts: 4`, and output `"HELLO"`. This state can arise when the worker stops during the third attempt’s first-step delay.
   Fix: Handle interrupted attempts explicitly during recovery. Enforce the retry limit and ensure an interrupted third simulated failure becomes `failed` with `"transient failure"` and `attempts: 3`, while still recovering interrupted successful processing.

2. [major] src/server.ts:25 — Storing input directly as SQLite TEXT corrupts valid JavaScript strings and breaks idempotent replay.
   Evidence: Calling the submission functions with input `"a\u0000b"` against an in-memory database returned a created job whose input was `"a"`. Replaying the identical payload and key returned `conflict`. A lone surrogate also round-tripped as a replacement character. These strings satisfy the specified validation rules; processing consequently uses altered input.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode consistently for API responses, payload comparisons, and processing. Verify embedded NUL characters and lone surrogates survive submission, replay, and completion.