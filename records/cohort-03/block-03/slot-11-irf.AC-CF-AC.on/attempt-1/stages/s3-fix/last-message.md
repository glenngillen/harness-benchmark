All three reviewer findings are fixed. `npm run build` exits 0, and both fixed check suites pass (smoke 2/2, contract 5/5).

**What changed**
- **Lossless text (finding 1):** `input` and output are now stored as JSON-encoded text in `input_json` and `result_output_json`. JSON escapes NULs and lone surrogates, so they round-trip exactly. The worker, API responses, and idempotency comparison all decode the same way. A job with `"ab\u0000cd\ud800x"` now returns that exact input and the uppercased output, and replays with the same key return 200.
- **Attempt counting (finding 2):** Recovery and graceful-stop requeues no longer decrement `attempts`. Each claim increments it, capped at 3. A job interrupted during its final attempt re-runs that attempt without starting a fourth one. In a restart test, a job with `failAttempts: 5` showed attempts 2 after recovery and ended `failed` with attempts 3.
- **Body limit (finding 3):** I removed the 16 KiB cap. A body with 17,000 leading spaces now returns 201. The cost is that request bodies are buffered without a size bound.

**Things to know**
- The column rename means databases created by the previous version won't work with this code. Delete `data/jobs.db` (or the configured `DATABASE_PATH`) before running.
- I did not add a request-size limit, as the spec doesn't define one. If you want protection against very large bodies, it would need a documented value.