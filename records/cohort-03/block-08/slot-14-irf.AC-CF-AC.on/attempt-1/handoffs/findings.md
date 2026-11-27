# Review findings

1. [major] src/worker.ts:40 — Graceful shutdown can bypass the three-attempt failure limit.
   Evidence: If SIGTERM arrives during the first step of attempt 3 with `failAttempts: 3`, this branch requeues the job before recording its terminal failure. Startup recovery only examines `running` jobs, so restarting claims attempt 4, which succeeds because `4 > failAttempts`. Reproducing these database transitions produced `attempts: 4`.
   Fix: Handle the terminal simulated failure before the shutdown requeue branch, so an interrupted third failing attempt cannot return to the queue and later succeed.

2. [major] src/jobs.ts:109 — Storing input directly as SQLite TEXT corrupts some valid JavaScript strings.
   Evidence: An in-memory test using the actual submission functions stored `"a\u0000b"` but returned `"a"`; `"a\ud800b"` returned `"a�b"`. Replaying either original payload with its original key returned `conflict`. These inputs pass validation, but exact input preservation, uppercase output, and idempotency are broken.
   Fix: Store input and result strings in a lossless encoding, such as JSON-encoded text, and decode them when reading rows before comparison, processing, or returning API responses.