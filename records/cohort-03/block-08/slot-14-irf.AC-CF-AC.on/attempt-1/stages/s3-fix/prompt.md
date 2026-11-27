A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:40 — Graceful shutdown can bypass the three-attempt failure limit.
   Evidence: If SIGTERM arrives during the first step of attempt 3 with `failAttempts: 3`, this branch requeues the job before recording its terminal failure. Startup recovery only examines `running` jobs, so restarting claims attempt 4, which succeeds because `4 > failAttempts`. Reproducing these database transitions produced `attempts: 4`.
   Fix: Handle the terminal simulated failure before the shutdown requeue branch, so an interrupted third failing attempt cannot return to the queue and later succeed.

2. [major] src/jobs.ts:109 — Storing input directly as SQLite TEXT corrupts some valid JavaScript strings.
   Evidence: An in-memory test using the actual submission functions stored `"a\u0000b"` but returned `"a"`; `"a\ud800b"` returned `"a�b"`. Replaying either original payload with its original key returned `conflict`. These inputs pass validation, but exact input preservation, uppercase output, and idempotency are broken.
   Fix: Store input and result strings in a lossless encoding, such as JSON-encoded text, and decode them when reading rows before comparison, processing, or returning API responses.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
