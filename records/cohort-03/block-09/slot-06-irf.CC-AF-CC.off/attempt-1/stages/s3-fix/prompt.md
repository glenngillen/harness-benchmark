A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:13 — When the worker restarts, any job left `running` goes back to `queued` with its `attempts` count unchanged. The next claim then adds 1 again, so a job can pass 3 attempts in total. That breaks the retry rules: a job with `failAttempts: 3` that was killed during attempt 3 is reprocessed as attempt 4. Because 4 > `failAttempts`, it **completes**, when it should end `failed`. With `failAttempts` ≥ 4 it ends `failed` with `attempts: 4`, not the required 3. The same happens after a graceful `SIGTERM`, because `processJob` returns early and leaves the row `running` (lines 41 and 54).
   Evidence: `UPDATE jobs SET status='queued', progress_completed=0 ... WHERE status='running'` does not touch `attempts`. `claim()` always does `attempts=attempts+1`. `processJob` compares `job.attempts <= job.fail_attempts` and only checks `>= 3` on the failure path.
   Fix: Don't count the interrupted attempt twice. On recovery, also set `attempts = MAX(attempts-1, 0)` so the re-run reuses the same attempt number. Alternatively, at claim time, if `attempts >= 3` the job has no attempts left, so mark it `failed` with "transient failure". Either way, never let `attempts` exceed 3. Consider handling the graceful `SIGTERM` case the same way: requeue the in-flight job and roll back its attempt before exiting.

2. [minor] src/server.ts:113-145 — The request handler is async, but only the POST branch has a try/catch. If SQLite throws during `GET /health`, `GET /api/jobs` or `GET /api/jobs/:id` (for example `SQLITE_BUSY` after the 5 s busy timeout while the worker holds a write lock), the result is an unhandled promise rejection. On Node 22 that crashes the server process.
   Evidence: There is no try/catch around the `db.prepare(...).get/all` calls on the GET paths.
   Fix: Wrap the whole handler body in try/catch and return a JSON `500` (for example code `internal_error`) if no headers have been sent yet.

3. [minor] src/worker.ts:63-73 — Any exception in `claim()` or `processJob()`, such as a busy or locked error, ends the main loop. The `finally` then closes the DB and the worker stops for good. Nothing restarts it, so its heartbeat stops and queued jobs stall.
   Evidence: There is no try/catch inside `while (!stopping)`.
   Fix: Catch errors on each iteration, log them, sleep briefly and continue. The loop should exit only when `stopping` is set.

4. [minor] src/server.ts:147-149 — On `SIGTERM`, the shutdown waits for `server.close()`, which waits for in-flight and keep-alive connections. The UI polls every 700 ms over keep-alive, so with a browser open the server may not exit promptly.
   Evidence: `shutdown()` only calls `server.close(cb)` and sets no timeout.
   Fix: Call `server.closeIdleConnections()` (or `closeAllConnections()`) after `close()`, and add a fallback `setTimeout(() => process.exit(0), 2000).unref()`.

5. [minor] src/server.ts:89-102 — In the idempotent replay path, if the key exists but its job row is missing, the code runs `COMMIT` and then falls through to insert a new job outside the transaction. The `INSERT INTO idempotency` then hits a primary key conflict, which surfaces as a misleading `400 invalid_request` "could not read body". The idempotency rows currently can't be removed, so this is unlikely, but the control flow is fragile.
   Evidence: `if (row) return ...` has no `else`, after the `COMMIT` at line 92.
   Fix: Do the lookup and return while still inside the transaction, committing just before returning. If the row is missing, treat it as an internal error rather than falling through.

6. [minor] src/server.ts:62-66 — Malformed JSON produces two `body` entries ("Must be valid JSON." and "Must be a JSON object."), because `body` stays `undefined` after the parse fails. The response is still valid, just noisy, and the UI's `form-error` shows both messages.
   Evidence: The object check runs whether or not parsing succeeded.
   Fix: Run the object check only if parsing succeeded.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
