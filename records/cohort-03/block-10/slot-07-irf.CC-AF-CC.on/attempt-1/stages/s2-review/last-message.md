# Review findings

1. [major] src/worker.ts:11-13 — When the worker starts, any job still marked `running` and already on its 3rd attempt is set to `failed` with `error: "transient failure"`. The job is never run again. The task says a job that was `running` when the worker died "is processed again". It also says "transient failure" belongs only to attempts that fail because of `failAttempts`, not to a worker crash.
   Evidence: The recovery `UPDATE` sets `status = CASE WHEN attempts>=3 THEN 'failed' ...`. Take a job with `failAttempts: 2`: attempts 1 and 2 fail as designed, and attempt 3 is running. If the worker is killed with SIGKILL then, it should complete as `HELLO` after restart. Instead it ends up `failed`. The same thing happens to any job sitting on attempt 3 for any reason.
   Fix: Don't decide the outcome during recovery. Set crashed `running` jobs back to `queued` (`progress_completed=0`, `retry_at=0`) and let the normal loop run them. Either allow the crashed attempt to be retried even after 3 attempts, or decrement `attempts` during recovery so the interrupted attempt doesn't count. That way the job runs again and completes, or fails only through the `failAttempts` rule. Make sure jobs that are already completed or failed are never touched.

2. [minor] src/worker.ts:47-53 — If SIGTERM arrives during a job, the worker exits and leaves that job in `running` until a worker starts again. Nothing is lost, because restart recovery picks it up, but `GET /api/jobs` keeps showing a stale `running` job while the worker is down.
   Evidence: `if (interrupted) break;` exits without changing the job's row.
   Fix: On a graceful stop, set the interrupted job back to `queued` (`progress_completed=0`, `attempts=attempts-1`, `retry_at=0`) before closing the database.

3. [minor] ui/index.html:36 — If the steps or fail-attempts field is empty, `Number('')` sends `0`. An empty steps field then fails as an out-of-range `steps` instead of using the default, and an empty fail-attempts field quietly becomes `0`. The API still validates it, so this is cosmetic, but it can surprise users.
   Fix: Leave out a numeric field when it is empty so the server default applies. Otherwise send `Number(value)`.

I only read the code. I had no shell tool in this session, so I did not build or run the app. The rest of the server checks out when read against the spec: validation, the error shape, idempotency with `BEGIN IMMEDIATE` and a `UNIQUE` key, 404/405 handling, health heartbeat timing, and the timing and attempt counting for `failAttempts`.