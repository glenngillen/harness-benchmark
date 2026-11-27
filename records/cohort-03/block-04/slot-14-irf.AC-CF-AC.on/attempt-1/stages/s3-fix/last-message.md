Both findings are fixed, and the build and both check suites pass. Nothing is committed.

**Finding 1 (restart recovery past the attempt limit): fixed.** Recovery now checks each interrupted `running` job. If the interrupted attempt was a failing attempt at number 3 or later, the job is marked `failed` with `error: "transient failure"` and `attempts` unchanged. Otherwise it is requeued as before. `claimNext` applies the same rule before starting an attempt, so an over-limit failing attempt is never run. In a live run, the reviewer's state (running, attempts 3, failAttempts 3) now ends `failed` with `attempts: 3`.

**Finding 2 (lossy text storage): fixed.** `input` and the result are now stored as JSON-encoded text (`input_json`, `result_json`), so NUL characters and unpaired surrogates round-trip. The worker decodes the input, uppercases it, and encodes the output. Through the API, `"a\u0000b\ud800c"` comes back as `"A\u0000B\ud800C"`.

Two things to know:
- The column rename changes the schema. A database file created by the previous build would not work with this one, so delete any old `DATABASE_PATH` file before running. The fixed checks use fresh databases, so they are unaffected.
- A failing attempt that is rejected at claim time fails immediately, without the 100 ms first-step delay. The outcome and fields are the same.

Regression checks after the change: failAttempts 2 still completes on attempt 3, the idempotency replay still returns 200, a job killed mid-run by SIGKILL completes after restart, and both processes exit 0 on SIGTERM.