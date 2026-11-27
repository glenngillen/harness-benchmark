A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:20-22 — The browser's own form validation stops many invalid submissions before they reach the API. The `required`, `maxlength="1000"` and `min`/`max`/`step` attributes block the submit event, so the API never sees the request and `form-error` stays empty. The task requires the form to send the values to `POST /api/jobs` so the API's validation applies, and `form-error` must show the rejection with each field's name.
   Evidence: With steps = 0 or 25, fail attempts = 9, steps = 2.5, or an empty input, the browser shows its own tooltip and the submit handler never runs. `maxlength` also stops anyone typing more than 1000 characters. Only cases like whitespace-only input reach the API.
   Fix: Add `novalidate` to the `<form>`, or remove `required`, `maxlength`, `min`, `max` and `step`. The API will then reject these values and `renderError` will show them.

2. [minor] src/worker.ts:9,22,31-33 — Crash recovery can push `attempts` past the 3-attempt cap. When the worker restarts, it puts `running` jobs back in the queue, and `claim()` then always adds 1 to `attempts` with no upper limit. A job that was on attempt 3 when the worker was killed restarts as attempt 4. With `failAttempts` ≥ 4 it would then end `failed` with `attempts: 4`, but the spec says a failed job has `attempts` set to 3.
   Evidence: `claim()` sets `attempts = row.attempts + 1` unconditionally. Failure is only checked with `job.attempts >= 3`, after the counter has already gone up.
   Fix: When recovering at startup, or in `claim()`, if `attempts >= 3`, either mark the job `failed` (if its last attempt counts as failed) or reuse the count instead of incrementing past 3. Never write a value above 3.

3. [minor] src/worker.ts:50-60 — Any exception in the main loop stops the worker for good. The loop has `try/finally` but no `catch`, so a database error (for example `SQLITE_BUSY` after the 5 s timeout while the server holds a write lock, or a failed UPDATE) exits the process. From then on queued jobs are never processed and `/health` reports `down`.
   Evidence: `claim()` rethrows errors, `processJob` has no error handling, and nothing catches errors inside the `while` loop.
   Fix: Wrap each pass of the loop in `try/catch`. Log the error, sleep briefly and continue. Also catch errors in `processJob` so the job is left in a state that can be retried.

4. [minor] src/server.ts:26,45 — A request body over 1 MB returns `500 internal_error`. The task says rejected input must return `400 invalid_request`. `readBody` throws, but the `try` at line 45 only wraps `JSON.parse(await readBody(req))`. That `catch` would report it as "invalid JSON", but if the stream errors in another way the outer handler returns 500.
   Evidence: The `body too large` throw is caught by the JSON `catch`, which works by luck. A client aborting the request goes to the outer `.catch` and returns 500 (or destroys the connection).
   Fix: Handle body-read errors explicitly and return 400 `invalid_request` with field `body` (for example "Body too large").

5. [minor] src/server.ts:136 — The server listens only on `127.0.0.1`. An evaluator that connects to `localhost` resolved to `::1`, or from another network namespace or container, gets connection refused. The task asks for a server on `PORT`, with no host restriction.
   Evidence: `server.listen(port, '127.0.0.1', ...)`.
   Fix: Call `server.listen(port)` so it binds on all interfaces, or at least drop the hard-coded IPv4 loopback.

6. [minor] ui/index.html:47,85 — The whole job list is rebuilt every 750 ms with `list.replaceChildren()`. Any element reference the evaluator holds (a `job-item`, `job-status` and so on) goes stale within a second. That can make UI checks flaky (stale-element errors, or a text read landing between remove and re-add).
   Evidence: `render()` removes and recreates every `<li>` on each poll, even when nothing changed.
   Fix: Look up each item by `data-job-id`, update its status, progress and result text in place, insert new jobs at the top in newest-first order, and only remove jobs that no longer exist.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
