# Review findings

1. [major] src/worker.ts:36 — Restart recovery can exceed the three-attempt limit and complete a job that should fail.
   Evidence: Recovery requeues every running job, and `claimNext` unconditionally increments its attempts. Exercising recovery with a running job having `attempts: 3` and `failAttempts: 3` produced `status: "completed"`, `attempts: 4`, and output `"HELLO"`. This state can occur when the worker stops during the third attempt’s first step.
   Fix: Handle exhausted attempts during recovery and enforce the attempt limit when claiming jobs. An interrupted third attempt with `failAttempts >= 3` must end failed with `"transient failure"` and `attempts: 3`.

2. [major] src/jobs.ts:105 — SQLite text storage does not preserve all valid JavaScript input strings.
   Evidence: Calling `submitJob` against an in-memory database with input `"a\u0000b"` returned input `"a"`; input `"\ud800"` returned `"�"`. Both pass the specified validation. The worker also reads this altered input, so its uppercase output is incorrect.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode them when constructing job objects and processing input. Verify round trips and uppercase results for embedded NUL characters and unpaired surrogates.