A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:17-20 — The browser blocks invalid submissions before they reach the API, so `form-error` stays empty. The form has no `novalidate`. The input field has `required` and `maxlength="1000"`, and the number fields have `min`/`max`. Entering steps `50`, failAttempts `9`, or an empty input never sends a `POST /api/jobs`. The browser shows its own tooltip instead. The task says the form sends the values "so the API's validation applies" and that `form-error` shows the API's rejection with the field names. An evaluator that enters out-of-range values and waits for `form-error` to name `steps` or `failAttempts` will fail.
   Evidence: `<form data-testid="job-form">` has no `novalidate`. `<input ... required maxlength="1000">` and `type="number" min="1" max="20"`.
   Fix: Add `novalidate` to the `<form>`. Either remove `required`/`maxlength`/`min`/`max` or leave them only as hints, so that every submit reaches the API.

2. [major] src/worker.ts:9, 33, 46, 64 — An interrupted attempt is requeued but still counts, so a job can run more than 3 attempts. The startup recovery and the SIGTERM paths set the job back to `queued` without changing `attempts`, and `claim()` then increments it again. Take a job with `failAttempts: 2` that is killed during attempt 3. It restarts as attempt 4 and completes with `attempts: 4`, but the task allows "up to 3 attempts in total". If `failAttempts ≥ 4` and the job is interrupted during attempt 3, `processJob` fails it with `attempts: 4`, but the task requires `attempts` to be 3. Nothing in `claim()` caps attempts at 3.
   Evidence: `UPDATE jobs SET status='queued', progress_completed=0 ... WHERE status='running'` leaves `attempts` alone. `claim` runs `attempts=attempts+1` with no upper bound.
   Fix: Decide on one rule and apply it in all four places. Either decrement `attempts` when requeuing an interrupted attempt (`attempts=MAX(attempts-1,0)`), or have `claim()` never go past 3. Also make the fail/complete decision use `attempts` clamped to 3.

3. [minor] src/server.ts:28-107 — The request handler is an `async` callback with no top-level try/catch. Any exception from `db.prepare(...).get/all` throws inside it: on `GET /api/jobs`, `GET /api/jobs/:id` or `/health`, for example `SQLITE_BUSY` once the 5 s busy timeout runs out while the worker holds the write lock. That becomes an unhandled rejection, which kills the server process in Node 22. Only the insert path is protected.
   Evidence: Only lines 77-97 are inside try/catch. The `db.prepare` calls at lines 32, 41 and 103 are not.
   Fix: Wrap the whole handler body in try/catch. In the catch, return `500 {"error":{"code":"internal_error",...}}` if headers have not been sent yet.

4. [minor] src/server.ts:109 — `SIGTERM` shutdown can hang. `server.close()` waits for in-flight and keep-alive connections, and there is no forced exit. An open keep-alive connection from a client such as the UI's 500 ms polling, or a slow request, can delay shutdown indefinitely.
   Evidence: `process.on(signal, () => server.close(() => { db.close(); process.exit(0); }))` has no timeout and does not call `closeAllConnections`.
   Fix: After calling `server.close(...)`, call `server.closeIdleConnections()` and `server.closeAllConnections()`. Add a fallback `setTimeout(() => process.exit(0), 2000).unref()`.

5. [minor] src/worker.ts:10-12 — If the heartbeat `INSERT` throws, the worker crashes. `heartbeat` runs from `setInterval` with no try/catch, so an error such as `SQLITE_BUSY` under contention becomes an uncaught exception. `/health` would then report `down`, and queued jobs would stop being processed until someone restarts the worker.
   Evidence: `const heartbeatTimer = setInterval(heartbeat, 750);` where `heartbeat` calls `db.prepare(...).run(...)` without protection.
   Fix: Wrap the body of `heartbeat` in try/catch and log the error. A missed beat is acceptable; a crash is not.

6. [minor] ui/index.html:42 — An empty Steps or Fail attempts field is sent as `0`, because `Number('')` returns `0`. For steps, that turns "leave it blank to use the default" into a 400 error. For failAttempts, it quietly sends 0.
   Evidence: `steps:Number(steps.value), failAttempts:Number(failures.value)`.
   Fix: Leave out the key when the field is blank, e.g. `...(steps.value.trim() !== '' ? {steps: Number(steps.value)} : {})`, so the server's defaults apply. Keep sending numbers otherwise.

I only had file-reading tools, so I did not build or run anything. These findings come from reading the code. The validation, idempotency (`BEGIN IMMEDIATE` plus the `idempotency` table), ordering, the heartbeat window, the retry delay (500 ms), the step timing (100 ms) and the UI test IDs all look correct against the spec.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
