# Plan

## Approach
Use one SQLite database (WAL mode, busy_timeout, as `src/db.ts` already sets up) as the only link between the two processes. It holds a `jobs` table, with a unique `idempotency_key` column and a `next_run_at` column for retry delays, plus a single-row `worker_heartbeat` table. The server is a plain `node:http` router that validates input strictly, reads and writes jobs, and serves `ui/index.html`. The worker polls every 200 ms. It claims the oldest runnable queued job with one atomic `UPDATE … RETURNING`, runs the 100 ms steps and writes progress after each one, and handles retries by putting the job back in `queued` with a future `next_run_at`. When the worker starts, it puts any job left in `running` back in the queue. The UI is a vanilla JS page that reads `GET /api/jobs` once a second.

## Files
- `src/db.ts`: keep `openDatabase`. Add the schema setup (`CREATE TABLE IF NOT EXISTS`, run by both processes), the row type, `rowToJob(row)` to build the API JSON shape, and a `nowIso()` helper.
- `src/server.ts`: rewrite with the router, body reading, validation, idempotency, JSON errors, `/health`, the UI route, and SIGTERM handling.
- `src/worker.ts`: rewrite with the heartbeat, crash recovery, the claim loop, step processing, retries, and SIGTERM handling.
- `ui/index.html`: the form, the job list, the polling script, and all required `data-testid`s. Keep the path the same, because the server reads `../ui/index.html` relative to `dist/server.js`.

## Steps
1. **Schema** (in `db.ts`, after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     next_run_at INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL);
   ```
   - Columns map to the job fields as follows. `result` is `{output}` only when status is completed and is `null` otherwise. `error` is `null` unless the job failed. `progress` is `{completed: progress_completed, total: steps}`. Timestamps come from `new Date().toISOString()`. Ids come from `crypto.randomUUID()`.
   - `payload` holds the canonical JSON `JSON.stringify({input, steps, failAttempts})`, built after defaults are applied and always with keys in that order.
2. **Server router.** Parse the pathname with `new URL`, then route:
   - `/`: GET only. Serve the HTML.
   - `/health`: GET only.
   - `/api/jobs`: GET and POST.
   - `^/api/jobs/([^/]+)$`: GET only. Use `decodeURIComponent` inside try/catch and return 404 if it fails.
   - A known path with the wrong method returns 405 `method_not_allowed`. Anything else returns 404 `not_found`.
   - Every JSON response sets `content-type: application/json; charset=utf-8`.
   - Wrap the handler in try/catch and return 500 `internal_error` on failure.
3. **`/health`.** Read `beat_at`. Report `worker: "up"` only if `Date.now() - beat_at < 3000`.
4. **POST validation.** Read the whole body, then collect every problem into `fields[]` before responding:
   - **Content-Type:** take the part before `;`, trim and lowercase it, and require it to equal `application/json`. Otherwise add field `body`.
   - **JSON:** call `JSON.parse` in try/catch. Malformed JSON adds field `body`. A parsed value that is not a plain object (null, an array, or a primitive) also adds field `body`.
   - **Unknown keys:** each one adds its own key as a field.
   - **`input`:** must be a string, `length` 1–1000, and `trim() !== ''`. Store it untrimmed.
   - **`steps` and `failAttempts`:** if present, require `typeof === 'number' && Number.isInteger(v)` and the allowed range. If absent, apply the default. An explicit `null` is invalid.
   - **`Idempotency-Key` header:** if present and it fails `^[A-Za-z0-9_-]{1,128}$`, add field `Idempotency-Key`. Note that `req.headers['idempotency-key']` can be an array; treat that as invalid.
   - **Response:** if anything was collected, return 400 `{error:{code:'invalid_request', message, fields}}`.
5. **Create and idempotency.** Run `BEGIN IMMEDIATE` … `COMMIT`, with ROLLBACK on error.
   - If there is a key, `SELECT` by `idempotency_key`. If a job exists and its `payload` equals the new payload, return 200 with that job. If the payload differs, return 409 `idempotency_conflict`.
   - Otherwise `INSERT` the job with status `queued`, `next_run_at = 0`, and both timestamps set to now, then return 201.
   - Also catch a UNIQUE constraint error and fall back to re-running the lookup.
6. **Listing and lookup.** `GET /api/jobs` uses `ORDER BY seq DESC`. `GET /api/jobs/:id` returns the job or 404.
7. **Server shutdown.** On SIGTERM or SIGINT: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Add a 2 s fallback exit.
8. **Worker startup.**
   - Open the database and apply the schema.
   - Recover crashed jobs:
     ```sql
     UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0),
       progress_completed=0, next_run_at=0, updated_at=?
     WHERE status='running';
     ```
     The interrupted attempt is redone as the same attempt number. This keeps the cap of 3 attempts and makes `failAttempts` behave predictably.
   - Write the heartbeat right away (`INSERT … ON CONFLICT(id) DO UPDATE`), then again every 1000 ms with `setInterval`.
9. **Worker loop.** While not stopping:
   - Claim a job:
     ```sql
     UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
     WHERE id=(SELECT id FROM jobs WHERE status='queued' AND next_run_at<=?
               ORDER BY seq ASC LIMIT 1)
     RETURNING *;
     ```
     Call it with `.get()`. If nothing comes back, sleep 200 ms.
   - Let `n` be the new `attempts`.
   - **Failure path:** if `n <= fail_attempts`, sleep about 100 ms (the first step), then:
     - if `n >= 3`, set status `failed`, error `"transient failure"`, output NULL, progress 0;
     - otherwise set status `queued`, `next_run_at = Date.now() + 500`, progress 0.
   - **Success path:** for each step `i` from 1 to `steps`, sleep 100 ms, then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps. Finish with status `completed`, `output = input.toUpperCase()`, `progress_completed = steps`.
10. **Worker SIGTERM.** Set `stopping`. If a job is in progress, put it back in the queue as in step 8 (`attempts-1`, status `queued`). Clear the interval, `DELETE FROM worker_heartbeat`, `db.close()`, and exit 0. Do all of this within about 1 s: break out of the step sleep, or check the flag after each 100 ms step.
11. **UI.**
    - **Form:** `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input">` with no `required` attribute, so the API's validation produces the error;
      - `<input type="number" data-testid="job-steps" value="5">`;
      - `<input type="number" data-testid="job-fail-attempts" value="0">`;
      - `<button data-testid="job-submit">`;
      - `<div data-testid="form-error" role="alert"></div>`.
    - **Submit handler:**
      - Call `preventDefault`.
      - Build the body: `input` is the raw string. For each numeric field, leave it out if empty; use `Number(v)` if the value is numeric; otherwise send the raw string so the API rejects it.
      - `fetch` with `Content-Type: application/json`.
      - On a non-2xx response, fill `form-error` with the message plus each `field: message` using `textContent`.
      - On success, clear `form-error`, clear the input, and refresh right away.
    - **Job list:** `<ul data-testid="job-list">`. Poll every 1000 ms and re-render in the API's newest-first order.
      - Each job is an `<li data-testid="job-item" data-job-id=id>` with child spans `job-status`, `job-progress` (`${completed}/${total}`), and `job-result` (the output, the error, or `''`).
      - Use `textContent` only, never innerHTML, so user input can't inject markup.

## Behaviours to verify
- **Build and checks:** `npm run build && npm run check:smoke && npm run check:contract` all pass.
- **Validation:** use curl.
  - `-d '{"input":"a","steps":"3"}'` returns 400 with field `steps`.
  - Sending with no Content-Type returns 400 with field `body`.
  - `-d '[1]'` returns field `body`.
  - `-d '{bad'` returns field `body`.
  - `{"input":"   "}` returns field `input`.
  - Header `Idempotency-Key: a b` returns field `Idempotency-Key`.
  - After all of these, `GET /api/jobs` shows the job count unchanged.
- **Defaults:** `{"input":"a"}` returns 201 with steps 5 and failAttempts 0.
- **Idempotency:**
  - With key K, send `{"input":"a"}` and get 201. Send `{"input":"a","steps":5,"failAttempts":0}` with K and get 200 with the same id.
  - `{"input":"b"}` with K returns 409.
  - Restart the server and replay: still 200 with the same id.
- **Progress:** create a job with `steps:10`, poll `GET /api/jobs/:id` every 100 ms, and watch `progress.completed` rise through 1..10. The job should finish with `COMPLETED` output and `attempts: 1`.
- **Retries:**
  - `failAttempts:2` ends completed with attempts 3.
  - `failAttempts:3` ends failed with attempts 3, error `"transient failure"`, and result null.
  - Status should go back to `queued` between attempts.
- **Restart recovery:** start a `steps:20` job and `kill -9` the worker mid-run. The job stays `running`. Restart the worker and the job should complete within about 3 s.
- **Health:** shows `up` while the worker runs and `down` within 3 s of killing it. Start either process first and confirm both are fine.
- **Routes:** `DELETE /api/jobs` returns 405, `/nope` returns 404, `POST /health` returns 405.
- **SIGTERM:** `kill -TERM` makes each process exit with code 0 promptly.
- **UI:** open `/`.
  - Submitting with an empty input shows `input` in the alert.
  - A valid submission appears at the top, and its status and progress update with no reload.
- **Fresh database path:** run with `DATABASE_PATH=/tmp/x/y/jobs.db` and confirm the directories are created.

## Risks
- **Lock errors from the two processes writing at once.** Keep `busy_timeout`, use `BEGIN IMMEDIATE` for the idempotency transaction, and keep transactions short. Never hold a transaction open across `await`.
- **`node:sqlite` value types.** Columns may come back as numbers or bigint depending on settings, so wrap numeric columns in `Number(...)` inside `rowToJob`. Make sure `RETURNING` is called with `.get()`, not `.run()`.
- **Idempotency comparison.** Compare the canonical payload string built in a fixed key order, never the raw body. For example, `{"steps":5,"input":"a"}` must match `{"input":"a"}`.
- **Number checks.** `typeof v === 'number'` rejects `"3"`. `Number.isInteger` rejects `2.5`. `true` and `null` must be rejected too.
- **Browser validation getting in the way.** Without `novalidate`, or with `required` or `min` attributes on the inputs, the browser blocks the submission and `form-error` never shows the API's rejection.
- **Retry timing.** The retry delay must be at least 250 ms. With 500 ms and 200 ms polling, three attempts take under 3 s, which fits the 12 s check budget.
- **Over-polling.** Don't poll the database faster than about 100 ms. Do run the heartbeat on its own interval, so it isn't blocked while a long job is processing. The step sleeps are async, so the interval still fires.
- **Imports.** Keep the `./db.ts` import style, which `rewriteRelativeImportExtensions` handles. Don't import anything from `checks/`.