A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/store.ts:118 — SQLite TEXT storage corrupts some valid inputs.
   Evidence: An in-memory test using the source returned `"a"` after submitting `"a\u0000b"`, and `"a�b"` after submitting `"a\ud800b"`. Both pass validation. This violates exact input preservation and causes the worker to uppercase corrupted text.
   Fix: Encode input and output losslessly before SQLite storage, for example with JSON.stringify, and decode them when reading. Verify embedded NULs and unpaired surrogates survive submission, processing, and retrieval.

2. [major] src/store.ts:178 — Restart recovery incorrectly subtracts previously started attempts.
   Evidence: Claiming a job sets `attempts` to 1; `requeueRunning()` reduces it to 0; claiming it again reports 1 despite two attempts having started. `interrupt()` repeats this behavior on graceful shutdown. Restarting during processing therefore undercounts attempts and reuses failure-attempt numbers.
   Fix: Preserve the attempt count when requeuing interrupted jobs, increment it when processing starts again, and apply the retry limit consistently during recovery. Verify both SIGTERM and SIGKILL recovery paths.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
