I fixed all four findings, and the build and both check suites still pass (2/2 smoke, 5/5 contract).

1. **Recovery past the attempt limit (fixed).** `claimNext` in `src/worker.ts` now fails a queued job when its simulated failures are still pending and its three-attempt budget is spent, so it never starts attempt 4. A reproduction with a job interrupted during attempt 3 and `failAttempts: 3` ends `failed` with `attempts: 3`. A `failAttempts: 0` job interrupted three times still completes, as it should. A job that died during attempt 2 with `failAttempts: 3` fails on attempt 3.

2. **Shutdown erasing a started attempt (fixed).** The shutdown path no longer decrements `attempts`. It requeues the job with progress reset and the attempt still counted. A live test confirmed this: a 20-step job stopped mid-attempt showed `attempts: 1` and `queued`, then completed on restart with `attempts: 2`.

3. **HEAD returning 200 (fixed).** The HEAD-to-GET rewrite is gone, so HEAD on `/health`, `/api/jobs`, and `/` now returns 405. The spec lists only specific methods, so I read HEAD as unsupported.

4. **Missing field errors (fixed).** `validateSubmission` in `src/server.ts` now checks the `Idempotency-Key` header first and keeps its error when the body is malformed or the Content-Type is wrong. A malformed body with a bad key now returns both `Idempotency-Key` and `body` in `fields`.

I did not add a committed regression test. The fixed files and `checks/` rule out changing the test harness, and nothing in the repo runs unit tests. The reproductions I ran are in `$TMPDIR`, outside the repo.