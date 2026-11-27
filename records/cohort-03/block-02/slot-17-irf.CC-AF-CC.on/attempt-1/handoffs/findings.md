# Review findings

I only read the code. My tools couldn't build, start or call the app, so none of this was tested at runtime. The core requirements look correctly implemented, and I found no blockers.

1. [minor] src/worker.ts:28-36 — A job can go past the 3-attempt limit if the worker crashes during a job. The final-failure check only runs on simulated failures (`attempts <= fail_attempts`) and compares `attempts >= 3` only there. If a job is re-queued at startup (line 9) after a crash during attempt 3, it is claimed again as attempt 4. With `failAttempts: 0`, or `failAttempts: 2` where attempt 3 crashed, it then completes with `attempts: 4`. That breaks "up to 3 attempts in total".
   Evidence: `claim()` always does `attempts=attempts+1` and nothing caps it. The startup reset doesn't look at `attempts`.
   Fix: When claiming, if `attempts >= 3` already, mark the job `failed` with `error='transient failure'` and don't start another attempt. Or decide in the startup reset (line 9) whether the next attempt is allowed. Make sure `attempts` never goes above 3.

2. [minor] src/worker.ts:37-41 — The heartbeat is only written once per main-loop pass, so it isn't written while a job runs. A 20-step job takes about 2 s plus a DB write per step, and any lock wait (busy_timeout is 5 s) or slower step pushes the gap past 3 s. `/health` would then report `worker: "down"` while the worker is busy.
   Evidence: `heartbeat.run(...)` is only at line 25, before `claim()`. The step loop never refreshes it.
   Fix: Call `heartbeat.run(Date.now())` inside the step loop after each step. Better still, use an independent `setInterval` of about 1 s that writes the heartbeat, and clear it on shutdown.

3. [minor] src/server.ts:23-31 — Validation stops early, so some fields with errors aren't reported. If `Content-Type` is wrong, the JSON is malformed or the body isn't an object, the response lists only `body`. A bad `Idempotency-Key` sent at the same time is left out, even though the spec says each offending field must be listed.
   Evidence: Each early `return` sends a single `body` entry before the key check at line 42.
   Fix: Validate the `Idempotency-Key` header first and add its entry to `fields` before the content-type, JSON and object checks. Include it in every 400 response.

4. [minor] ui/index.html:63-65 — An empty Steps or Fail attempts field is sent as `0` (`Number('')` gives `0`), not left out. A cleared Steps field gets the confusing error "steps must be an integer from 1 to 20" instead of the default of 5. A cleared Fail attempts field silently sends `0`.
   Evidence: `steps: Number(stepsText), failAttempts: Number(failuresText)` with no check for an empty string.
   Fix: Leave a field out of the payload when its trimmed value is empty, so the API applies its defaults. Otherwise send `Number(value)`.

5. [minor] src/server.ts:58-66 — In the in-transaction idempotency re-check, the `COMMIT` at line 61 runs before the job row lookup. If the row is missing, code continues to the `INSERT` outside any transaction. The `COMMIT` at line 70 then fails with "no transaction is active", and the `ROLLBACK` in the catch fails too, giving a 500. This is unlikely because jobs are never deleted, but the control flow is fragile.
   Evidence: There is no `return` or re-`BEGIN` after `db.exec('COMMIT')` when `row` is undefined.
   Fix: Do the lookup and the 200/409 decision while still inside the transaction, and commit once on each path. Or treat a missing row as an internal error and return explicitly.