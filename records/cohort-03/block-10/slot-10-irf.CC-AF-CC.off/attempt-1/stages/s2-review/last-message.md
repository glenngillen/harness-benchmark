# Review findings

1. [major] ui/index.html:20-22 — The browser's built-in form validation stops the bad submissions from ever reaching the API. Because of `required`, `maxlength="1000"` and `min`/`max` on the number inputs, a blank input or a value like `steps=50` or `failAttempts=9` is blocked before the `submit` handler runs. Nothing is sent to `POST /api/jobs`, so `form-error` stays empty and shows no field names. The task says form submissions must go to the API "so the API's validation applies", and `form-error` must show the API's rejection.
   Evidence: `<input ... required maxlength="1000">` and `type="number" min="1" max="20"` / `min="0" max="5"`. In browsers, constraint validation blocks the `submit` event.
   Fix: Add `novalidate` to the `<form>`, or remove `required`, `maxlength`, `min` and `max`. That way every submission reaches the API and its errors appear in `form-error`.

2. [major] src/worker.ts:14-15 — On startup, recovery marks any job still `running` with `attempts >= 3` as `failed` with "transient failure", without processing it again. That is wrong when attempt 3 was meant to succeed. For example, a job with `failAttempts: 2` whose worker is killed mid-run on attempt 3 ends `failed`, though the task says a job interrupted mid-run "is processed again. It completes, or fails per the retry rules". A worker crash is not a transient failure of the job.
   Evidence: `UPDATE jobs SET status='failed', error='transient failure' ... WHERE status='running' AND attempts >= 3`.
   Fix: Requeue every `running` job on startup (`status='queued', progress_completed=0`). An attempt that the crash cut short should not count against the limit. One way is to decrement `attempts` for the interrupted attempt before requeueing, so the retry is still attempt 3 and `attempts` never goes above 3. Then `failAttempts` decides the outcome on the next run.

3. [minor] src/server.ts:76-92 — There is a transaction bug in the idempotency branch. In the "existing key" path, `COMMIT` runs first and then `getJob` runs inside the `try`. If anything after `COMMIT` throws, the `catch` runs `ROLLBACK` with no open transaction, which throws a second error. Also, if the referenced job row is missing, the code falls through and creates a new job without recording the key.
   Evidence: `db.exec('COMMIT')` comes before `getJob(...)`, inside the same `try`/`catch (e) { db.exec('ROLLBACK') }`. After `if (job) return ...` nothing else is returned, so the code drops through to the non-idempotent insert at lines 94-97.
   Fix: Read the existing row and the job inside the transaction, commit once at the end, and guard the rollback with `if (db.isTransaction)`. Never let the keyed path fall through to creating a job without a key.

4. [minor] src/server.ts:46 — The request handler is `async` and has no top-level try/catch. Any thrown error, such as `SQLITE_BUSY` after the busy timeout, the rollback error from finding 3, or `readBody`'s "body too large" (which is turned into an "invalid JSON" response), becomes an unhandled rejection. On Node 22 that crashes the server process, and the client never gets a response.
   Evidence: There is no `.catch` around the handler body. Only the `JSON.parse(await readBody(req))` call is wrapped.
   Fix: Wrap the handler body in try/catch. Return a 500 JSON error (`{error:{code:'internal_error',...}}`) when headers have not been sent, and log the error.

5. [minor] src/server.ts:112 — On `SIGTERM`, the server waits for `server.close()` to finish. Browser tabs polling every second keep keep-alive connections open, and an open request can hold `close` indefinitely. The process may then not exit cleanly within a reasonable time.
   Evidence: `const shutdown = () => server.close(() => { db.close(); process.exit(0); });`. Nothing calls `closeAllConnections()` and there is no fallback timer.
   Fix: After `server.close(...)`, call `server.closeIdleConnections()`. Add a fallback such as `setTimeout(() => { server.closeAllConnections(); }, 2000).unref()`, and make sure `db.close()` and `exit(0)` still run.

6. [minor] src/worker.ts:6,64-72 — On `SIGTERM`, the worker sets a flag but finishes the whole current job before exiting. A 20-step job takes about 2 seconds, which is acceptable. However, the `claim()`/`runJob` loop has no error handling: any SQLite error (for example `SQLITE_BUSY` while the server holds `BEGIN IMMEDIATE`) throws out of the loop, closes the DB, and the worker exits for good.
   Evidence: `while (!stopping) { const job = claim(); ... }` sits inside `try/finally` with no `catch`.
   Fix: Catch errors on each loop iteration, log them, sleep briefly and continue. Optionally, check `stopping` between steps and requeue the job if shutting down.