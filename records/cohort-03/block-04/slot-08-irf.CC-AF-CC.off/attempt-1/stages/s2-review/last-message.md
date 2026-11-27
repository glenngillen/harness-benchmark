# Review findings

1. [major] src/server.ts:54-59 — The `Idempotency-Key` header is only checked after the content type, JSON parsing and body fields all pass. If a request has both an invalid body and an invalid key, `fields` lists only the body problems. The task says each offending field must be listed.
   Evidence: `fieldErrors(parsed)` returns early with its errors at line 55, so the regex check at 57 never runs. The same happens on the Content-Type (49) and malformed-JSON (53) error paths.
   Fix: Check the key first and keep its error. Then combine it with any body, Content-Type or JSON errors into one `fields` array and send a single 400.

2. [major] src/worker.ts:10,23-28 — A job that was `running` when the worker died is requeued, and the next claim adds 1 to `attempts` again. A job interrupted during its 3rd attempt is therefore run a 4th time and can complete with `attempts: 4`. The task allows at most 3 attempts in total. The failure path also checks `nextAttempt >= 3` rather than `== 3`: with `failAttempts` of 4 or 5, a 4th attempt reached this way ends `failed` with `attempts: 4`, but the task requires `attempts` to be 3.
   Evidence: The startup requeue keeps `attempts`, and `claim` always does `attempts=attempts+1`. Nothing caps attempts at 3.
   Fix: Pick one rule and apply it everywhere. Either (a) the interrupted attempt is redone without counting: on startup, set `attempts = attempts - 1` for running rows. Or (b) on startup, a running row with `attempts >= 3` becomes `failed` with `transient failure`. Clamp `attempts` to 3 when marking a job failed.

3. [major] src/server.ts:36-90 — The request handler is an `async` callback and nothing catches exceptions in it. Any exception in a non-POST route rejects the promise without a handler, and on Node 22 that crashes the server process. Examples are SQLITE_BUSY or a database error in `GET /api/jobs`, `/health` or `GET /api/jobs/:id`. The client gets no 500.
   Evidence: Only the POST insert block has a try/catch. Every other `db.prepare(...).get/all` call is unguarded.
   Fix: Wrap the whole handler in try/catch and return `500 {"error":{"code":"internal_error",...}}` if no response has been sent yet. Also add a `process.on('unhandledRejection')` logger as a safety net.

4. [minor] src/worker.ts:19-37 — The heartbeat is only written once per loop iteration, so it pauses for the whole job. A 20-step job takes about 2.0–2.2 s of sleep plus database writes. That is close to the 3 s `/health` window, and any stall from the 5 s busy-timeout pushes it over, so `/health` briefly reports the worker as `down` while it is busy.
   Evidence: `heartbeat.run` is called only at line 20. The step loop (32-36) never refreshes it.
   Fix: Also call `heartbeat.run(Date.now())` in each step, or run it from a `setInterval` (about 1 s) that is cleared on shutdown.

5. [minor] src/worker.ts:20,24-25,35 — A SQLite error in the worker loop kills the worker. This covers `BEGIN IMMEDIATE` (outside the try), `heartbeat.run`, `updateProgress.run`, `finish`/`retry`/`fail`, and the `ROLLBACK` inside the catch. Any of them can throw SQLITE_BUSY or a similar error, and nothing restarts the worker, so jobs stop being processed.
   Evidence: There is no try/catch around the loop body. The `BEGIN IMMEDIATE` at line 24 sits before the `try`.
   Fix: Wrap each loop iteration in try/catch. Log the error, sleep briefly and continue. The startup requeue logic already handles a job left `running`.

6. [minor] src/worker.ts:25 — The worker never checks whether `claim` actually updated a row. If the row is no longer `queued`, for example because a second worker is running against the same file, the job is processed anyway, and the guarded `updateProgress`/`finish` statements quietly do nothing.
   Evidence: The `claim.run(...)` result, `changes`, is ignored.
   Fix: If `claim.run(...).changes !== 1`, `continue` instead of processing.

7. [minor] src/server.ts:15 — The body is built with `body += chunk.toString()`, which decodes each chunk on its own. A multi-byte UTF-8 character that straddles two chunks is corrupted, so the input is not "stored exactly as sent". The 100 000 limit also counts characters, not bytes.
   Evidence: Each chunk is decoded separately and the pieces are joined as strings.
   Fix: Collect the Buffers, enforce the limit on total bytes, and decode once with `Buffer.concat(chunks).toString('utf8')`.

8. [minor] src/server.ts:37 — Paths that begin with `//` are read as protocol-relative URLs. `new URL('//x/api/jobs', 'http://localhost')` has pathname `/api/jobs`, and `GET //anything` serves the UI with 200 instead of returning 404 `not_found`.
   Evidence: `req.url` is passed as the first argument to `new URL`.
   Fix: Parse with `new URL('http://localhost' + (req.url ?? '/'))`, or split `req.url` on `?` and use the path directly.

I only read the code for this review. I did not build or run the app, so none of these was reproduced by running it.