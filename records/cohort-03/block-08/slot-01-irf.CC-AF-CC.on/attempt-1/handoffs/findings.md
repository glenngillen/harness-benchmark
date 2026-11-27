# Review findings

1. [major] ui/index.html:28-30 — The form's native HTML validation blocks some bad input before it reaches the API. Out-of-range steps or failAttempts (for example 50 or -1), or an empty input, never get sent to `POST /api/jobs`. The submit handler never runs, so `form-error` stays empty. The task says form submissions must go to the API so the API's validation applies, and that `form-error` must show the rejection with each offending field's name. An evaluator that types `steps=50` or `failAttempts=9` and clicks submit will see no request and no alert.
   Evidence: The inputs have `required`, `min`, `max` and `maxlength="1000"`, and the `<form>` has no `novalidate`. Browsers cancel the `submit` event when constraint validation fails.
   Fix: Add `novalidate` to `<form data-testid="job-form">`. You can also drop `required`, `min`, `max` and `maxlength` so the API is the only validator.

2. [major] src/worker.ts:12, 25, 33-36 — Crash recovery always adds an attempt, so the 3-attempt limit can be exceeded and the result can be wrong. Take a job with `failAttempts: 3` where the worker is killed during attempt 3, inside the 100 ms failure sleep. On restart the job is re-queued and claimed as attempt 4. Since 4 > failAttempts, it **completes**, but `failAttempts ≥ 3` must end `failed` with `attempts: 3`. In the same way, a job interrupted on attempt 3 with `failAttempts: 0` completes with `attempts: 4`. The task allows at most 3 attempts in total and a failed job must have `attempts` equal to 3.
   Evidence: The recovery `UPDATE` resets running jobs to queued and leaves `attempts` alone. The claim then runs `attempts=attempts+1` with no upper bound. The failure check uses `attempt <= job.failAttempts`, and the terminal check uses `attempt >= 3`.
   Fix: Never let `attempts` go above 3. When claiming a job that already has `attempts >= 3` (an interrupted final attempt), rerun attempt 3 without incrementing: `attempts = MIN(attempts+1, 3)`. Then evaluate failure against that capped number, so `failAttempts ≥ 3` still ends `failed` with `attempts=3`.

3. [minor] src/server.ts:43-107 — The request handler is an `async` function with no try/catch. Any thrown error becomes an unhandled promise rejection, which kills the server process under Node 22's default policy. Examples are `SQLITE_BUSY` after the 5 s busy timeout, or the rethrow in the `ROLLBACK` path at line 97. The client also never gets a response.
   Evidence: There is no `try` around the route logic, and `createServer(async (req,res)=>…)` has no rejection handling.
   Fix: Wrap the handler body in try/catch. On error, reply `500 {"error":{"code":"internal_error","message":…}}` if headers haven't been sent yet, and log the error.

4. [minor] src/worker.ts:15-48 — The worker loop has the same weakness. Any database exception, such as busy beyond 5 s or a failure inside the claim transaction, is rethrown and crashes the worker. The heartbeat stops and queued jobs stall until someone restarts it by hand.
   Evidence: `catch (e) { db.exec('ROLLBACK'); throw e; }` at line 29. Nothing catches errors in the step or update statements either.
   Fix: Catch errors per iteration. Log them, sleep briefly, and continue. Only exit when `stopping` is set.

5. [minor] src/server.ts:66-68 — Malformed JSON or an empty body produces two `body` entries in `fields`. The parse failure pushes one, then `validatePayload(undefined)` pushes another ("Must be a JSON object."). This is harmless but noisy, and a strict check may expect one entry per offending field.
   Evidence: `JSON.parse` fails and pushes `body`. `parsed` stays `undefined`, and `validatePayload` returns a second `body` field.
   Fix: Skip `validatePayload` when parsing failed, for example by tracking a `parseOk` flag.

6. [minor] src/worker.ts:6, 40-45 — On `SIGTERM` during a job, the worker stops partway and leaves the job `running` with partial progress until a worker starts again. The startup recovery handles this, but it combines with finding 2. Each graceful restart during a job adds an extra attempt.
   Evidence: `for (...; step <= job.steps && !stopping; ...)` then `if (stopping) break;` with no status update.
   Fix: Either finish the current step and set the job back to `queued` with `attempts=attempts-1`, so the interrupted attempt isn't counted twice, or rely on the cap from finding 2. Make sure the job doesn't end up with more than 3 attempts.

I only read the code: I didn't build or run the app or the checks, so none of this was confirmed at runtime. The following look correct: routing (404/405), validation rules, idempotency (including the transactional re-check), the heartbeat and `/health`, retry delay (500 ms), polling (100 ms in the worker, 700 ms in the UI), ordering, and the `data-testid` markup.