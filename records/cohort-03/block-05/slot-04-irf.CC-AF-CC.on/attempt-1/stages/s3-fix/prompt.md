A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:21-23 — The browser's own form validation stops out-of-range or empty values before they reach the API, so the API's rejection never appears in `form-error`. The task says submissions go to `POST /api/jobs` "so the API's validation applies", and that `form-error` shows the rejection with each offending field's name.
   Evidence: `job-input` has `required` and `maxlength="1000"`. `job-steps` has `min="1" max="20" step="1"`. `job-fail-attempts` has `min="0" max="5"`. If a user (or the evaluator) enters steps `0` or `21`, failAttempts `9`, or an empty input and clicks `job-submit`, the browser blocks the `submit` event. No request is sent and `form-error` stays empty.
   Fix: add `novalidate` to the `<form>`, or remove `required`, `maxlength`, `min`, `max` and `step`. Then every submission reaches the API and its `fields` are shown.

2. [major] src/worker.ts:12-14 — When the worker starts, a job left `running` with `attempts >= 3` is marked `failed` with `"transient failure"` without being run again. The task says a job that was running when the worker died "is processed again" and completes or fails by the retry rules.
   Evidence: take a job with `failAttempts: 2`. If the worker is killed with SIGKILL during attempt 3, which would have succeeded, the job ends `failed` with error "transient failure" even though no transient failure happened. Its output is lost.
   Fix: set interrupted `running` jobs back to `queued` with `available_at=0`. Mark a job `failed` only after an attempt actually fails. If you want to keep the 3-attempt cap, at least don't record an interrupted attempt 3 as a transient failure. The simplest compliant option is to undo the interrupted attempt's count (`attempts = attempts - 1`) so the job is retried.

3. [minor] src/worker.ts:22-58 — The main loop has no error handling. Any SQLite error, such as `SQLITE_BUSY` after the 5 s busy timeout or a step update hitting a lock, throws out of the top-level loop and kills the worker. The job it was processing stays `running` until the worker is restarted.
   Evidence: there is no try/catch around `beat()`, the claim/step `UPDATE`s, or the finish `UPDATE`s. The only catch is inside the claim, and it re-throws.
   Fix: wrap each loop iteration in try/catch. Log the error, sleep briefly and continue. If an error happens during processing, put the job back to `queued` so it isn't stuck.

4. [minor] src/server.ts:19-91 — The request handler is an async function with no top-level try/catch. If a DB call in the `/health`, `GET /api/jobs` or `GET /api/jobs/:id` branches throws (for example the database is busy or locked), the result is an unhandled promise rejection. The client gets no JSON error, and under Node 22's default `--unhandled-rejections=throw` the server process crashes.
   Fix: wrap the handler body in try/catch and return `500 {"error":{"code":"internal_error",...}}` as JSON. `decodeURIComponent` on a malformed `%` escape throws `URIError` and needs the same handling. Return 404 for that case.

5. [minor] src/server.ts:93 — On SIGTERM, `server.close()` waits for open connections to end. A browser tab polling every 500 ms keeps a keep-alive connection busy, so shutdown can stall or be delayed past what "shut down cleanly" allows.
   Fix: call `server.closeAllConnections()` (or `closeIdleConnections()` plus a short forced-exit timer) after `server.close(...)`, and add a fallback `setTimeout(() => process.exit(0), 3000).unref()`.

6. [minor] src/worker.ts:6,38-45 — On SIGTERM the worker only sets a flag and finishes the whole current job first, which takes up to 20 × 100 ms plus a retry. That is acceptable on its own, but the step loop never checks `stopping`.
   Fix: check `stopping` inside the step loop. If it is set, put the job back to `queued` (undoing the attempt count, consistent with finding 2), then exit, so shutdown is prompt and predictable.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
