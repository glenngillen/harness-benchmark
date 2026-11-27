# Review findings

I read every source file under `src/` and `ui/`, plus `tsconfig.json` and `package.json`. I did not build or run the app, so none of this was checked at runtime. Most of the required behaviour is there: routes and the 404/405 responses, the error shape, validation, idempotency (a UNIQUE key, with lookup and insert in one synchronous block), a 1 s heartbeat against a 3 s threshold, atomic claiming with `BEGIN IMMEDIATE`, a 500 ms retry delay, the 3-attempt cap, WAL mode with a busy timeout, and every `data-testid` in the UI with a 1 s poll. I found no blockers.

1. [minor] src/worker.ts:28-35 — After a crash, recovery lowers `attempts` by 1 (`attempts = MAX(attempts - 1, 0)`). The task defines `attempts` as "the number of processing attempts started so far", and this makes it undercount.
   Evidence: Take a job with `failAttempts: 0`, SIGKILL the worker mid-run, and restart it. The job finishes with `attempts: 1`, though two attempts were started. A job that crashes the worker every time is also retried forever and never hits the 3-attempt cap.
   Fix: Keep `attempts` as it is during recovery and just requeue with `status='queued', completed=0, next_run_at=0`. If the stored attempt count has already reached `MAX_ATTEMPTS`, mark the job `failed` with `"transient failure"` instead. Because the `attempt <= fail_attempts` check runs on every new attempt, the transient-failure rules still apply after a restart.

2. [minor] src/worker.ts:81-82 — On SIGTERM during a job, the job is left as `running` with partial progress. Nothing requeues it until a worker starts again, so after a graceful stop it shows `running` forever.
   Evidence: `if (stopping) return;` exits without updating the row. `recoverInterrupted` only runs at startup.
   Fix: On graceful stop, put the in-flight job back in the queue (`status='queued', completed=0, attempts=attempts-1, next_run_at=0`) before closing the DB. Or let the current job finish, since it takes at most 20 × 100 ms = 2 s, well within the shutdown window.

3. [minor] src/server.ts:24-37 — `readBody` only settles its promise on `end` or `error`. If a client disconnects mid-upload, `aborted`/`close` may fire without `end`, leaving the request handler hanging. It also keeps reading after the body passes 64 KB instead of stopping.
   Evidence: There is no `close` or `aborted` listener, and nothing calls `req.destroy()` or stops reading once `tooLarge` is set.
   Fix: Listen for `close` and resolve with null (or reject) if `end` hasn't fired. Once the size limit is exceeded, send the 400 right away (or after draining the body).

4. [minor] src/server.ts:85 — `new URL(req.url, 'http://localhost')` reads a request target that starts with `//` as an authority. For example, `GET //api/jobs` parses to host `api`, pathname `/jobs`, and returns 404, while `GET //` serves the HTML page. A malformed target that makes `URL` throw ends up as a 500 instead of the 404 `not_found`.
   Evidence: Line 85 has no guard for these cases.
   Fix: Take the path yourself: `const pathname = (req.url ?? '/').split('?')[0]`. Return 404 `not_found` for anything that doesn't start with a single `/`. Wrap the parse in try/catch and send 404 on failure.

5. [minor] src/server.ts:122 — `Number(process.env.PORT ?? 3000)` gives `0` when `PORT` is set but empty, so the server binds a random port. Any other non-numeric value gives `NaN`, and `listen` throws.
   Evidence: `??` only catches undefined, not `''`.
   Fix: `const port = Number(process.env.PORT) || 3000;`. If you want to be strict, check that the result is an integer from 1 to 65535.