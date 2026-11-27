# Review findings

1. [major] src/worker.ts:10,23,33-38 — A job can go over the 3-attempt cap after a worker restart. On startup, `running` jobs are put back in the queue with `attempts` unchanged, and `takeJob` then adds 1 again. The 3-attempt check only runs on the failure path (`job.attempts <= job.failAttempts`), so a successful attempt is never limited.
   Evidence: Take a `failAttempts: 2` job and kill the worker (SIGKILL or SIGTERM) during attempt 3. On restart it runs as attempt 4 and completes with `attempts: 4`. A `failAttempts: 0` job killed 3 times reaches `attempts: 4` or more. The spec says "up to 3 attempts in total". Graceful SIGTERM also leaves the job `running` (line 41) and uses up an attempt.
   Fix: When recovering a `running` job, either undo the interrupted attempt (`attempts=attempts-1` on recovery, or on graceful stop) or treat it as a failed attempt. In both cases, enforce the cap in `takeJob`: never start attempt n > 3; mark the job `failed` with `"transient failure"` instead. On SIGTERM, set the in-flight job back to `queued` with its attempt undone instead of leaving it `running`.

2. [major] src/worker.ts:49-55 — The heartbeat is only written between jobs, never while a job is processing. A 20-step job takes about 2 s plus DB writes. Slower steps, busy waits, or back-to-back long jobs can leave a gap close to or over 3 s, and `/health` then reports `worker: "down"` while the worker is working.
   Evidence: `heartbeat()` is only called at the top of the loop. `processJob` awaits `steps × 100 ms` without writing one.
   Fix: Run the heartbeat on its own `setInterval` (e.g. every 1 s, `unref`'d and cleared on shutdown). Also write it right after the queue-reset at startup, so `/health` turns `up` straight away.

3. [minor] src/server.ts:38-92 — The request handler is an `async` callback with no try/catch. Any exception becomes an unhandled promise rejection: SQLITE_BUSY after the 5 s busy_timeout, a failing `ROLLBACK`, or a `jobFromRow` JSON parse error. In Node 22 that crashes the server process, and the request gets no response.
   Fix: Wrap the handler body in try/catch and return `500 {"error":{"code":"internal_error","message":...}}`. Add a `req.on('error')` guard in `readBody`.

4. [minor] src/server.ts:70-77 — If an idempotency row exists but its job does not, the code has already run `COMMIT` and then falls through. It inserts a new job and a duplicate idempotency key outside any transaction, which throws a PK violation. The `catch` then calls `ROLLBACK` with no transaction open, which throws again. Combined with #3, this crashes the server.
   Fix: Don't commit early. Decide the response inside the transaction, commit once, then send. If the job is missing, return an error (or delete the stale key) inside the same transaction.

5. [minor] src/server.ts:96 — `server.close()` waits for every in-flight or keep-alive connection to end. A browser tab that keeps polling every 750 ms can delay or block a clean SIGTERM shutdown. There is also no fallback timeout.
   Fix: Call `server.closeAllConnections()` (or `closeIdleConnections()` plus a short timer) after `server.close()`, and add a forced `process.exit(0)` after about 3 s.

6. [minor] src/worker.ts:37 — The retry delay is a fixed 500 ms, but it is measured with `Date.now()` and then rounded up by the 200 ms idle poll. The real gap is about 500–700 ms, inside the 250 ms–2 s window, so this is fine today. However, `available_at` is only checked at poll time, and the poll interval is the only thing that guarantees "starts a newly queued job within 1 second". If the poll interval goes above roughly 1 s, both guarantees break.
   Fix: Keep the idle poll at 200–500 ms. Consider documenting the constraint, or computing the sleep as `min(200, available_at - now)`.