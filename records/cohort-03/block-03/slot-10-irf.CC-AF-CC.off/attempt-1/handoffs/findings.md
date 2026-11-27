# Review findings

1. [major] ui/index.html:25-27 — The browser's own validation stops invalid submissions before they reach the API. Because of `required` and `maxlength="1000"` on `job-input`, and `min`/`max` on the number fields, the browser blocks submits such as empty input, `steps` 50 or `failAttempts` 9. No request is sent, so `form-error` stays empty. The task says the form sends values "so the API's validation applies", and that `form-error` shows the API's rejection with each offending field's name.
   Evidence: The form has no `novalidate`, and the inputs carry `required`, `maxlength`, `min` and `max`. When a constraint fails, the browser cancels the `submit` event, so the handler never runs.
   Fix: Add `novalidate` to the `<form>`, or remove `required`, `maxlength`, `min` and `max`, so every submit goes to `POST /api/jobs` and the API's `fields` are shown.

2. [major] src/server.ts:38-128 — The async request handler has no try/catch, so any exception becomes an unhandled promise rejection, which kills the Node 22 process. One simple trigger: `decodeURIComponent` throws `URIError` on a malformed escape such as `GET /api/jobs/%E0%A4%A`, and that one request stops the server. Errors from SQLite are not caught either: `SQLITE_BUSY` after the 5 s busy timeout, or an INSERT failure when there is no idempotency key (the `throw e` on line 114).
   Evidence: `createServer(async (req, res) => {...})` has no surrounding try/catch, and nothing handles the returned promise.
   Fix: Wrap the handler body in try/catch and return a JSON 500 (`{"error":{"code":"internal_error",...}}`). Treat a failed `decodeURIComponent` as `404 not_found`.

3. [major] src/worker.ts:13, 26, 38-41 — Crash recovery can push a job past the 3-attempt limit. The startup requeue keeps `attempts`, and the next claim adds 1 again. Example: a job is killed during its 3rd attempt (say `failAttempts: 2`). On restart it runs as attempt 4 and ends `completed` with `attempts: 4`. The failure check also only fires for `attempts >= 3` *inside* the `attempts <= fail_attempts` branch. So a recovered job with `attempts > 3` and `attempts > fail_attempts` just runs again, breaking "up to 3 attempts in total".
   Evidence: In `claim()`, `attempts=attempts+1` runs on every claim, and the recovery UPDATE does not cap or check attempts.
   Fix: In `claim()`, or before starting an attempt, if `attempts >= 3` already, mark the job `failed` with `error='transient failure'` and don't start another attempt. Also decide failure as `attempts >= 3 && failed` regardless of the branch order.

4. [minor] src/worker.ts:64-69 — The heartbeat is only written between jobs. A 20-step job runs about 2.0–2.3 s without a heartbeat, which is close to the 3 s `/health` window. Any slowdown (busy DB, slow disk, GC) makes `/health` report `worker: "down"` while the worker is busy.
   Evidence: `heartbeat()` is called only at the top of the `while` loop. `processJob` awaits every step with no heartbeat.
   Fix: Write the heartbeat from a `setInterval` (for example every 1 s), or call it inside the step loop. Clear the interval on shutdown.

5. [minor] src/server.ts:132-134 — On `SIGTERM`, `server.close()` waits for all connections to finish. A client holding a keep-alive or long-running connection can delay exit indefinitely, but the task requires a clean shutdown.
   Evidence: There is no `server.closeAllConnections()` and no fallback timeout.
   Fix: After `server.close(...)`, call `server.closeIdleConnections()` or `closeAllConnections()`, and add a short fallback timer that runs `db.close(); process.exit(0)`.

6. [minor] src/server.ts:27 — When the body passes 1 MB, `readBody` rejects but keeps reading the stream. A huge upload still gets read completely before the 400 is sent.
   Evidence: After `reject`, the `data` handler stays attached and `req` is not paused or destroyed.
   Fix: After rejecting, call `req.removeAllListeners('data')` and `req.resume()`, or respond 400 right away and destroy the request.