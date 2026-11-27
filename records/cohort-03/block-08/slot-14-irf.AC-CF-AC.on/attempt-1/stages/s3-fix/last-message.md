Both findings are fixed. The build passes, smoke passes 2/2, and contract passes 5/5.

**Finding 1 (shutdown bypassing the attempt limit): fixed.** In `src/worker.ts`, a failing attempt now checks for the third attempt first and records the terminal `failed` state. Only then does it check for shutdown. A final failing attempt can no longer be requeued and later run as attempt 4.

**Finding 2 (lossy text storage): fixed.** In `src/jobs.ts`, `input` and `result_output` are stored as JSON-encoded text, which escapes NUL characters and lone surrogates as ASCII. Rows are decoded on every read, so comparisons, processing, and API responses all see the original string. I checked this against the in-memory database for `"a\u0000b"` and `"a\ud800b"`. Each stores and returns the exact input, produces the correct uppercase output, and replays under its original key with the same job id.

I did not reproduce the finding 1 scenario end to end, because it needs a SIGTERM at an exact moment in the first step of attempt 3. The fix follows from reading the code.