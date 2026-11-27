A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:20-21 — The browser's own form validation can block submissions before they reach the API, so `form-error` never shows the rejection. `steps` and `failAttempts` have `min`/`max` (and an implicit `step=1`), and `input` has `required`/`maxlength`. If you enter `steps=50`, `failAttempts=9`, `steps=2.5` or an empty input, the browser stops the submit, no `POST /api/jobs` is sent, and `form-error` stays empty. The task says form values must be sent to the API "so the API's validation applies", and that `form-error` must show the API's rejection with each field's name.
   Evidence: `<input ... type="number" min="1" max="20">`, `<input ... required maxlength="1000">`, and the form has no `novalidate`. The submit handler only runs after the browser's validation passes.
   Fix: Add `novalidate` to the `<form>`, or remove `required`/`maxlength`/`min`/`max`. Then every submission goes to the API and its 400 `fields` are shown.

2. [major] src/server.ts:96 — A bad percent-encoding in the job id crashes the whole server. `decodeURIComponent` throws `URIError` on input like `/api/jobs/%E0%A4%A`. The request handler is async and has no try/catch, so the rejection is unhandled, and Node 22 exits the process. Any unexpected throw inside the handler has the same effect, for example a SQLite busy error rethrown at line 92.
   Evidence: `getJob(db, decodeURIComponent(match[1]))` is called with no guard, `createServer(async (req,res)=>{...})` has no catch, and there is no `unhandledRejection` handler.
   Fix: Wrap the whole handler body in try/catch. Answer a `URIError` with `404 not_found`, and anything else with `500 {"error":{"code":"internal_error",...}}`, so the process keeps running.

3. [minor] src/worker.ts:10,21,31 — Crash recovery can push a job past the 3-attempt limit. On startup every `running` row goes back to `queued` without checking `attempts`. If the worker dies during attempt 3, `claim()` raises `attempts` to 4. With `failAttempts` ≥ 4 the job then ends `failed` with `attempts: 4`, but the task requires exactly 3. With `failAttempts` 2 it runs a 4th attempt and completes.
   Evidence: The requeue query is `UPDATE jobs SET status='queued' ... WHERE status='running'`, and `claim` does `attempts=attempts+1` with no upper bound. The failure check at line 31 is `job.attempts >= 3`, so it fails at 4, not 3.
   Fix: When recovering a `running` job, either don't count the interrupted attempt (decrement `attempts`), or mark jobs with `attempts >= 3` as `failed` with `error='transient failure'`. Also clamp the attempt count so it never goes above 3.

4. [minor] src/server.ts:48-56 — When there are several problems, validation returns early and lists only some of them. With a missing or non-JSON `Content-Type`, or malformed JSON, the response leaves out an invalid `Idempotency-Key`. The task says "each offending field" should be listed.
   Evidence: The `Content-Type` branch and the JSON parse branch both return before the `Idempotency-Key` check at line 69-70.
   Fix: Check the `Idempotency-Key` header first, keep its error in `fields`, and merge it into every 400 response.

5. [minor] src/worker.ts:48-58 — Errors in the worker are not caught. A SQLite error (for example `SQLITE_BUSY` after the 5 s timeout, while the server holds `BEGIN IMMEDIATE`) in `claim()` or a progress update escapes the loop. The worker then exits, leaves the job `running`, and stops the heartbeat until someone restarts it.
   Evidence: `while (!stopping) { const job = claim(); ... }` has no try/catch around each iteration.
   Fix: Catch errors per iteration, log them, sleep briefly and continue. Only exit when `stopping` is set.

I reviewed the code by reading it only; I didn't build, run or call the app. Everything else I checked looks correct against the task: the routes and 404/405 handling, the validation rules, idempotency (inside a transaction, keyed on the payload after defaults), the heartbeat, oldest-first claiming, the retry delay (500–750 ms), step timing, progress updates, completion and output, SIGTERM handling, `DATABASE_PATH`/`PORT`, and UI polling every 1 s.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
