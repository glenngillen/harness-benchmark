# Review findings

1. [major] src/store.ts:118 — SQLite TEXT storage corrupts some valid inputs.
   Evidence: An in-memory test using the source returned `"a"` after submitting `"a\u0000b"`, and `"a�b"` after submitting `"a\ud800b"`. Both pass validation. This violates exact input preservation and causes the worker to uppercase corrupted text.
   Fix: Encode input and output losslessly before SQLite storage, for example with JSON.stringify, and decode them when reading. Verify embedded NULs and unpaired surrogates survive submission, processing, and retrieval.

2. [major] src/store.ts:178 — Restart recovery incorrectly subtracts previously started attempts.
   Evidence: Claiming a job sets `attempts` to 1; `requeueRunning()` reduces it to 0; claiming it again reports 1 despite two attempts having started. `interrupt()` repeats this behavior on graceful shutdown. Restarting during processing therefore undercounts attempts and reuses failure-attempt numbers.
   Fix: Preserve the attempt count when requeuing interrupted jobs, increment it when processing starts again, and apply the retry limit consistently during recovery. Verify both SIGTERM and SIGKILL recovery paths.