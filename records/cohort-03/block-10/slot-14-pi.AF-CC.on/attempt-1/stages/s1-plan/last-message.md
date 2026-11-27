# Plan

## Approach
Use one SQLite schema, created by both processes when they start (`src/db.ts`), with a `jobs` table and a single-row `worker_heartbeat` table. The server is a plain `node:http` router. It validates requests strictly, handles idempotency with a UNIQUE column inside a `BEGIN IMMEDIATE` transaction, and serves a static HTML page. The UI is plain JS that polls `GET /api/jobs` every second. The worker is a loop. It writes a heartbeat about every second, takes the oldest queued job that is due inside a transaction, runs the steps with a ~100 ms sleep each, and writes progress after every step. It handles retries through a `run_after` timestamp. When it starts, it puts any job left `running` by a dead worker back in the queue. Keep the existing `./db.ts` import style (`rewriteRelativeImportExtensions` is on) and keep reading `../ui/index.html` relative to `dist/server.js`.

## Files
- `src/db.ts`: keep `openDatabase`. Add `ensureSchema(db)`, which `openDatabase` calls. Add shared helpers: the `JobRow` type, `rowToJob(row)` (maps to the API JSON shape) and `nowIso()`.
- `src/server.ts`: rewrite as router, validation, idempotency, health and UI serving, plus SIGTERM handling.
- `src/worker.ts`: rewrite as heartbeat, recovery, claim loop, step processing, retries, plus SIGTERM handling.
- `ui/index.html`: form, error region and job list with the required `data-testid`s, plus inline script.

## Steps
1. **Schema** (`CREATE TABLE IF NOT EXISTS`, run after the existing PRAGMAs):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload TEXT)`.
   `worker_heartbeat(id INTEGER PRIMARY KEY CHECK (id=1), beat_at INTEGER NOT NULL)` stores epoch milliseconds.
   `rowToJob` sets `result` to `{output}` only when status is completed, and `error` only when failed. Otherwise both are null.
2. **Server helpers:** `send(res, status, body)` always sets `content-type: application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)`. `readBody(req)` collects the body as a string and caps it at about 1 MB; above the cap it returns 400 `invalid_request` with field `body`.
3. **Routing** on `pathname`:
   - `/` takes GET (serves the HTML).
   - `/health` takes GET.
   - `/api/jobs` takes GET and POST.
   - `/api/jobs/<id>` takes GET. Match it with `^/api/jobs/([^/]+)$` and decode the id.
   - A known path with the wrong method returns 405 `method_not_allowed` with an `Allow` header.
   - Anything else returns 404 `not_found`.
   - Wrap the handler in try/catch so an unexpected error returns 500 `internal_error`.
4. **Validation for POST** (collect every error into `fields`, then return 400 `invalid_request` if there are any):
   - Content-Type: split on `;`, trim and lowercase. If it is not `application/json`, or the header is missing, add a `body` error and do not parse the body.
   - Idempotency-Key: if the header is present (including an empty string), it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add field `"Idempotency-Key"`. Check this even when the body is also invalid.
   - `JSON.parse` failure → `body`. A result that is null, an array or not an object → `body`.
   - Each key not in {input, steps, failAttempts} → an error with that key as the field.
   - `input`: must be present and `typeof input === 'string'`, with `1 <= length <= 1000` and `input.trim().length > 0`. Store it untrimmed.
   - `steps` and `failAttempts` (if present, `undefined` aside): must be `typeof === 'number'`, `Number.isInteger`, and within range. A value of `null` is a type error.
   - Apply defaults: steps 5, failAttempts 0.
5. **Create and idempotency:** `payload = JSON.stringify({input, steps, failAttempts})` in that fixed key order.
   - With a key: `BEGIN IMMEDIATE`, then `SELECT` by `idempotency_key`.
     - If a row exists, COMMIT and return 200 with that job if its payload matches, or 409 `idempotency_conflict` if it doesn't.
     - Otherwise INSERT, COMMIT and return 201.
     - On an exception, ROLLBACK.
   - Without a key: plain INSERT with `idempotency_key` NULL (multiple NULLs are allowed under UNIQUE).
   - Set `id = crypto.randomUUID()`, status `queued`, `run_after = 0`, and `created_at`/`updated_at` to now as ISO strings.
6. **GET routes:** `GET /api/jobs` uses `ORDER BY seq DESC`. `GET /api/jobs/:id` returns the job or 404 `not_found`. `GET /health` reads `beat_at`; `worker` is `up` iff a row exists and `Date.now() - beat_at < 3000`.
7. **Server SIGTERM/SIGINT:** call `server.close()` and `server.closeAllConnections()` (polling keep-alive connections would otherwise hang), then `db.close()` and `process.exit(0)`. Add a 2 s fallback exit timer, `unref`'d.
8. **Worker startup:**
   - Open the db.
   - Write a heartbeat immediately (`INSERT ... ON CONFLICT(id) DO UPDATE`), then every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is redone under the same number, so the total never exceeds 3 and `failAttempts` semantics still hold.
9. **Worker loop** (`while (!stopping)`):
   - Claim: `BEGIN IMMEDIATE`, then `SELECT * FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq LIMIT 1`. If found, `UPDATE` it to status `running`, `attempts = attempts+1`, `progress_completed = 0`, `updated_at`, then COMMIT.
   - If nothing was claimed, sleep 200 ms.
   - Process the claimed job with attempt number `n = attempts+1`:
     - **Failure** (`n <= fail_attempts`): sleep about 100 ms (the first step) with no progress write.
       - If `n >= 3`: set status `failed`, `error='transient failure'`, `result_output` NULL.
       - Otherwise: set status `queued`, `run_after = Date.now()+500`, `progress_completed = 0`.
     - **Success:** for i in 1..steps, sleep 100 ms and then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps. Finally set `completed`, `result_output = input.toUpperCase()`, `progress_completed = steps`.
10. **Worker SIGTERM:** set `stopping`, and use an AbortController to abort the current sleep (pass `{signal}` to `timers/promises` sleep and catch `AbortError`). Put the in-flight job back in the queue the same way recovery does (attempts-1, queued). Delete the heartbeat row, clear the interval, `db.close()`, `process.exit(0)`.
11. **UI (`ui/index.html`):**
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - Do **not** put `required`, `min`, `max` or `step` attributes on these inputs, because they would block submission and stop the API's validation from running.
    - `<div data-testid="form-error" role="alert"></div>`, empty by default.
    - `<ul data-testid="job-list">`.
    - On submit: `preventDefault`. Build the body as `{input: value}` plus `steps: Number(v)` and `failAttempts: Number(v)` when the field is non-empty. `NaN` serialises to null, which the API rejects, so that is fine. POST it with the `Content-Type: application/json` header.
      - If the response is not ok: render `error.message` plus one line per field, `"<field>: <message>"`.
      - If it is ok: clear the error text, then refresh the list.
    - `refresh()`: fetch `/api/jobs` and reconcile `<li data-testid="job-item" data-job-id>` elements in order. Each item contains spans for `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`), plus the input text. Set content with `textContent`, never innerHTML. Run it with `setInterval(refresh, 1000)` and once on load.

## Behaviours to verify
- Build and start: run `npm run build`, start either process first, and check that `curl localhost:3000/health` shows `worker: up` within about 1 s of the worker starting, and `down` about 3 s after you SIGKILL it.
- Happy path: POST `{"input":"hello","steps":3}` returns 201 with status queued. Polling GET shows running with progress rising, then completed with `result.output = "HELLO"` and `progress` at 3/3.
- Retries: `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with attempts 3, `error "transient failure"` and result null.
- Validation: each of the following returns 400 with the right field:
  - `steps:"3"`, `steps:2.5`, `steps:0`, `steps:21`, `failAttempts:6`
  - `input:"   "`, input of 1001 characters
  - an extra field
  - body `[]`, `null`, `{bad`
  - `text/plain` or no Content-Type
  - Idempotency-Key `"a b"`, or 129 characters

  Then check that the job count is unchanged.
- Idempotency: send the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}`. The first returns 201 and the second 200 with the same id. The same key with a different input returns 409. Repeat after restarting the server.
- Routes: `/nope` returns 404 `not_found`. `DELETE /api/jobs` and `POST /api/jobs/x` return 405. `GET /api/jobs/unknown` returns 404. Every response is JSON.
- Durability: submit a job with steps 20, SIGKILL the worker while the job is running, restart the worker, and check that the job completes and its `attempts` value is sane. SIGKILL both processes, restart them, and check that all jobs are still listed and completed jobs are unchanged.
- SIGTERM: `kill -TERM` makes each process exit with code 0 within about 1 s.
- UI: open `/`, submit the form, and watch the item's status and progress update without reloading. Submitting steps 99 shows an alert containing "steps". Run `npm run check:smoke` and `npm run check:contract`.

## Risks
- **HTML validation attributes on the form:** they block the browser submit, so the API error never appears. Use `novalidate` and leave the inputs unconstrained.
- **Content-Type with parameters:** `application/json; charset=utf-8` must be accepted. Parse the media type instead of comparing the whole string.
- **Idempotency races and restarts:** rely on the DB UNIQUE constraint and the transaction, not on an in-memory map.
- **Newest-first ordering:** order by the `seq` autoincrement column, not by `created_at`, which can tie at millisecond resolution.
- **Recovery inflating attempts past 3:** decrement on requeue, as in step 8.
- **Hanging on shutdown:** keep-alive connections stall `server.close()`, and pending timers keep the worker alive. Use `closeAllConnections`, abortable sleeps and explicit `process.exit(0)`.
- **Lock errors:** `SQLITE_BUSY` can occur if `busy_timeout` is lost. Keep the existing PRAGMA order and keep transactions short and synchronous (no awaits inside BEGIN…COMMIT).
- **Reprocessing finished jobs:** completed and failed jobs must never be reprocessed. Claim only `status='queued'`, and make the progress and final UPDATEs include `WHERE id=? AND status='running'`.