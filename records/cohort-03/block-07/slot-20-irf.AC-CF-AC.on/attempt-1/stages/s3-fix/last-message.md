Both findings were correct and are fixed. The build passes, and `check:smoke` (2/2) and `check:contract` (5/5) pass.

**Finding 1 (restart recovery):** Removed the rule that failed interrupted jobs with `attempts >= 3`. An attempt interrupted by a crash or a graceful stop now goes back to `queued` with its attempt count rolled back, so the rerun is the same attempt number. `SIGKILL` (handled at worker startup) and `SIGTERM` use the same path. A `failAttempts: 2` job killed during its successful third attempt now completes on restart, with `attempts: 3`.

This is a judgment call. The spec says `attempts` counts "started" attempts, and I read an interrupted attempt that produced no outcome as not counting. If you want it to count, the alternative is a fourth attempt after a crash, which conflicts with the 3-attempt limit.

**Finding 2 (NUL characters):** `input` and `result` are now stored JSON-encoded (`input_json`, `result_json`) and decoded on read. Input `"a\u0000b\ud800"` round-trips exactly, and it processes to `"A\u0000B\ud800"`. Replaying the same payload with an `Idempotency-Key` returns 200, because the comparison uses the decoded value.

The schema columns were renamed, so a database created by the previous build won't open with this version. No such database existed in the repo, so nothing needed migrating.