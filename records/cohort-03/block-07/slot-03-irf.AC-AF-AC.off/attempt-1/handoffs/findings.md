# Review findings

1. [major] ui/index.html:27 — The `maxlength="1000"` on `job-input` makes the browser silently cut over-long input to 1000 characters. So when someone types or pastes more than 1000 characters, the form submits a valid, shortened job. The user never sees the API rejection, and `form-error` never names `input`. The task says the API's validation must apply to form submissions.
   Evidence: the input element has `maxlength="1000"`, and the submit handler sends `inputEl.value` exactly as it stands.
   Fix: remove `maxlength` (and avoid any other client-side limits) so the server alone decides validity and `form-error` shows its `fields`.

2. [major] src/worker.ts:84 — Recovering after a crash can push a job past 3 attempts. When the worker restarts, it sets `running` jobs back to `queued` but leaves `attempts` as it was. The next claim then adds 1 again. Example: a job with `failAttempts: 2` that is killed during attempt 3 runs again as attempt 4, completes, and reports `attempts: 4`. This breaks "up to 3 attempts in total".
   Evidence: the recovery query only changes `status` and `progress_completed`. `claimNext` computes `attempt = row.attempts + 1` and never compares a successful attempt against `MAX_ATTEMPTS`.
   Fix: when recovering, also run `attempts = MAX(attempts - 1, 0)` (the graceful-stop path at line 66 already does this). Or decide in `claimNext` what happens when `attempt > MAX_ATTEMPTS`, and use one approach consistently.

3. [minor] src/worker.ts:41-52 — An attempt that is meant to fail never sets the job to `running`. It goes straight from `queued` back to `queued`, or to `failed`. The task says every attempt sets the job to `running`, increments `attempts` and resets progress, and then fails at its first step.
   Evidence: in the fail branch, `claimNext` updates the row to `queued` or `failed` inside the claim transaction and never writes `status = 'running'`.
   Fix: claim the job as `running` (with `attempts + 1` and progress 0) in every case. Then handle the failure in a separate update, either right away or after a short pause, by requeueing with `next_run_at` or marking it `failed`.

4. [minor] src/worker.ts:94-97, 16-18 — Any SQLite error that gets past `busy_timeout`, in `claimNext`, a progress update or `heartbeat()` inside `setInterval`, crashes the worker for good. There is no catch or retry, so processing stops and `/health` turns `down`.
   Evidence: `main()` has no try/catch around the loop, and its `.catch` calls `process.exit(1)`. An exception thrown in the interval callback is uncaught and also ends the process.
   Fix: wrap each loop iteration and the heartbeat callback in try/catch, log the error, and continue after a short sleep.

5. [minor] src/server.ts:39-40 — A body over 64 KB gets the message "Request body must be JSON with Content-Type application/json", which is misleading. The status and code (`400 invalid_request`, field `body`) are correct.
   Evidence: when `tooLarge` is set, the code resolves with the same `bad` result it uses for a wrong Content-Type.
   Fix: return a separate `body` message such as "Request body too large".

I reviewed the code by reading it only. I did not build, start or call the app, so none of these findings has been confirmed at runtime.