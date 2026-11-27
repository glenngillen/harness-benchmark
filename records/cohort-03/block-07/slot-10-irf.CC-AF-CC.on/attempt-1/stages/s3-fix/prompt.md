A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:16-19 — The browser's own form validation stops submission before the API ever sees it. The input has `required` and `maxlength="1000"`, and the number fields have `min`/`max`. If a user enters steps `0` or `25`, fail attempts `9`, or an empty input, the browser blocks the submit and shows its own tooltip. No `POST /api/jobs` is sent, so `form-error` stays empty. The task requires that "the API's validation applies" and that `form-error` shows the rejection with each offending field's name. A check that types an out-of-range value and expects `form-error` to mention `steps` or `failAttempts` will fail.
   Evidence: `<input ... name="steps" type="number" min="1" max="20">`, `<input ... required maxlength="1000">`, and the `<form>` has no `novalidate`. Native constraint validation runs before the `submit` event fires.
   Fix: Add `novalidate` to the `<form data-testid="job-form">` element, or remove `required`/`maxlength`/`min`/`max`. That way every submission goes to the API and the server's `fields` are shown in `form-error`.

2. [minor] src/worker.ts:46-50 — The heartbeat is only written between jobs, never while one is running. A 20-step job takes at least about 2.0 s of sleeps plus 21 SQLite writes, and each write can wait up to `busy_timeout` 5000 ms if the server holds the write lock. That puts it close to, or over, the 3-second window, so `/health` can report `worker: "down"` while the worker is busy processing.
   Evidence: `heartbeat()` is called only at the top of the `while` loop. `processJob` loops `steps` times with `await sleep(100)` and never refreshes the heartbeat.
   Fix: Call `heartbeat()` after each step inside `processJob`, or run it from a separate `setInterval(heartbeat, 1000)` and clear the interval on shutdown.

3. [minor] src/server.ts:63-88 — The request handler is an `async` callback with no top-level try/catch. Only the POST branch catches errors. If a DB call throws on `GET /api/jobs`, `GET /api/jobs/:id` or `/health` (for example `SQLITE_BUSY` after 5 s under contention), the result is an unhandled promise rejection, which crashes the Node 22 server process. The client gets no JSON response.
   Evidence: `db.prepare(...).all()` / `.get()` in the GET branches are not wrapped, and `createServer(async (req,res)=>{...})` has no catch.
   Fix: Wrap the whole handler body in try/catch. If headers haven't been sent, respond `500 {"error":{"code":"internal_error",...}}`.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
