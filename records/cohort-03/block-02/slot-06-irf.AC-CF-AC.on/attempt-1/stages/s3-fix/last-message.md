All three findings were correct, and I've fixed each. The build passes, and smoke (2/2) and contract (5/5) pass.

**Changes**

1. **Lossless text (`src/jobs.ts`, `src/db.ts`, `src/server.ts`, `src/worker.ts`).** Input and result are now stored as JSON text (`input_json`, `result_json`), which escapes NUL bytes and lone surrogates. They are decoded on read and in the idempotency comparison. A test with `a\u0000b\ud800c` round-trips exactly, uppercases to `A\u0000B\ud800C`, and a keyed replay returns 200.
2. **Attempt budget (`src/jobs.ts`).** The claim only takes jobs with `attempts < 3`, and the increment is guarded the same way. An interrupted attempt (shutdown release or expired-lease recovery) is now uncounted, so the same attempt number reruns. A job killed during attempt 3 reruns as attempt 3 and never reaches 4. Test: `failAttempts: 2`, killed mid-attempt-3, restarted, and it completed with `attempts=3`.
3. **First-step timing (`src/worker.ts`).** Every attempt now waits one step (100 ms) before the simulated failure check. A failing attempt still records no progress.

**Things to know**
- The schema renamed two columns, so a database file created by the previous build won't work with this one. The fixed checks and the tests above all use fresh databases. If you have an old `jobs.db`, delete it before starting.
- I did not directly time the first-step delay for failed attempts. My probe ran before the worker picked the job up. The change is confirmed by reading the code, not by measurement.
- I did not commit. The changes are uncommitted in the working tree.