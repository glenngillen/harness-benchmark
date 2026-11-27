# Review findings

1. [major] ui/index.html:11-13 — The browser's own form validation blocks bad submissions before they reach the API, so `form-error` never shows the API's rejection for them. `required`, `maxlength="1000"`, `min`/`max` on steps (1–20) and `min`/`max` on failAttempts (0–5) all do this. For example, steps `0` or `25`, or failAttempts `9`, never sends a request. The task says the form must send values to `POST /api/jobs` "so the API's validation applies", and that `form-error` must show the rejection with each field's name.
   Evidence: `<input ... required maxlength="1000">` and `<input ... type="number" min="1" max="20">`. A submit event does not fire while any constraint fails, so the alert region stays empty.
   Fix: Add `novalidate` to the `<form>`, or remove `required`, `maxlength`, `min` and `max`. Let the API's 400 response fill `form-error`, which the code at line 46 already does correctly.

2. [major] src/worker.ts:14 — On startup, a job that was `running` on attempt 3 is set straight to `failed` with `error='transient failure'`. It is never processed again, even when that attempt was not meant to fail. Example: `failAttempts: 2`, worker SIGKILLed during attempt 3. That job should complete, but it ends `failed` with a made-up "transient failure" and is never run again. The task says a job that was running when the worker died "is processed again" and "completes, or fails per the retry rules".
   Evidence: `UPDATE jobs SET status='failed' ... WHERE status='running' AND attempts>=3` runs before the job is claimed again.
   Fix: Requeue every interrupted `running` row (`status='queued', progress_completed=0`). Two options for the 3-attempt cap: (a) let the interrupted attempt run again, for example by decrementing `attempts` for interrupted rows; or (b) only mark it failed when the attempt would itself fail (`attempts <= fail_attempts`). Either way, an attempt that was going to succeed must not end as "transient failure".

3. [minor] src/worker.ts:68 — On shutdown the worker writes a fresh heartbeat (`heartbeat(); db.close();`). After a clean `SIGTERM`, `/health` therefore reports `worker: "up"` for up to 3 more seconds even though the worker is gone.
   Evidence: Line 68 calls `heartbeat()` after the main loop exits.
   Fix: On shutdown, `DELETE FROM worker_heartbeat WHERE id=1` (or set `seen_at=0`) instead of refreshing it.

4. [minor] src/worker.ts:40-67 — The main loop has no error handling. If any SQLite call throws (for example `SQLITE_BUSY` after the 5 s busy timeout while the server holds `BEGIN IMMEDIATE`, or a disk error), the worker crashes with an unhandled rejection. The current job stays `running` until someone restarts the worker manually.
   Evidence: `claim()`, the progress `UPDATE`s and the completion `UPDATE` have no try/catch. Only `claim()` rolls back, and then it rethrows.
   Fix: Wrap each iteration in try/catch. On error, log it, requeue `activeId` if one is set, sleep briefly, and continue. Keep the heartbeat going.

5. [minor] src/worker.ts:58-59 — On `SIGTERM` during a job, the worker requeues the job without counting the interruption against the attempt limit. This is acceptable as written. However, `finishInterrupted` does not clear `error`/`result_output`, and `attempts` stays incremented. A job that is repeatedly interrupted on attempt 3 therefore runs into finding 2 on the next start.
   Evidence: `finishInterrupted` only sets `status='queued', progress_completed=0`.
   Fix: Handle this together with finding 2, so interrupted attempts are treated the same way whether the shutdown was graceful or a SIGKILL.

I only read the code for these findings. I did not build, run or test anything. The rest looked correct to me: validation, error shapes, 404/405 routing, idempotency (checked inside a `BEGIN IMMEDIATE` transaction, unique key, payload compared after defaults), retry delay (500 ms), progress updates after each step, newest-first ordering, and the UI polling every 750 ms.