# Plan

## Approach
Both processes share one SQLite schema module (`src/db.ts`). The server is a single `node:http` handler that routes, validates and does idempotent inserts inside a `BEGIN IMMEDIATE` transaction. The worker is a polling loop: every ~200 ms it claims the oldest due queued job, runs the steps with `await sleep(100)`, writes progress after each step, and handles retries by setting the job back to `queued` with a `run_after` timestamp. A separate interval writes a heartbeat row every second, and `/health` reads it. When the worker starts, any job still marked `running` came from a dead worker (there is only one worker), so it is re-queued. The UI is one static HTML file with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for `jobs` and `heartbeat`, plus shared helpers: `rowToJob(row)`, `nowIso()`.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotency, the health check and SIGTERM handling.
- `src/worker.ts`: rewrite with recovery, the poll/claim loop, step processing, retries, the heartbeat and SIGTERM handling.
- `ui/index.html`: the form, the job list and the polling script, using the required `data-testid`s.

## Steps
1. **Schema** in `db.ts`, run on open by both processes. Each statement is idempotent.
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload_json TEXT)`
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL)`
   - Index on `(status, run_after, seq)`.
   - `rowToJob` builds the exact JSON shape: `progress: {completed, total: steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`.
   - Keep the `./db.ts` import style. `rewriteRelativeImportExtensions` is on.
2. **Server helper:** `send(res, status, body)` always sends `application/json; charset=utf-8`. Add `sendError(res, status, code, message, fields?)`.
3. **Routing** (path checked first, then method):
   - `/` (GET → HTML)
   - `/health` (GET)
   - `/api/jobs` (GET, POST)
   - `/api/jobs/<id>` (GET; `decodeURIComponent` inside a try, and a bad encoding returns 404)

   A known path with any other method returns `405 method_not_allowed`. Anything else returns `404 not_found`. Wrap the handler in try/catch so an exception returns `500 internal_error` as JSON.
4. **`/health`:** read `beat_at`. Return `worker: Date.now() - beat_at < 3000 ? 'up' : 'down'`. A missing row means down.
5. **POST validation.** Collect every error into `fields`, then return 400 if there are any.
   - `Content-Type` must exist and match `/^application\/json\b/i` (charset allowed). Otherwise add field `body`. Still read and drain the request body.
   - `Idempotency-Key` header: if present (even empty), it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add field `Idempotency-Key`.
   - Read the body as a utf8 string with a cap of about 1 MB. Larger bodies get a `body` error.
   - If `JSON.parse` throws, add a `body` error. If the result is not a plain object (null, array or primitive), add a `body` error.
   - For an object, report each unknown key under its own name.
   - `input`: must be `typeof 'string'`, `1 ≤ length ≤ 1000` and `input.trim().length > 0`. Store it exactly as sent.
   - `steps` / `failAttempts`: if present, they must satisfy `typeof v === 'number' && Number.isInteger(v)` and fall in range. `"3"` is rejected. Apply defaults 5 and 0.
6. **Create / idempotency.** Run `BEGIN IMMEDIATE` … `COMMIT`, with `ROLLBACK` on error. Use canonical `payload = JSON.stringify({input, steps, failAttempts})` with a fixed key order.
   - If a key was sent, `SELECT` by `idempotency_key`.
     - Found, same `payload_json` → `200` with that job.
     - Found, different payload → `409 idempotency_conflict`.
   - Otherwise `INSERT` with `id = crypto.randomUUID()`, status `queued`, attempts 0, `run_after = 0`, and identical ISO timestamps → `201`.
   - Without a key, store `idempotency_key` as NULL, so SQLite UNIQUE allows many rows.
7. **`GET /api/jobs`:** `ORDER BY seq DESC`, so newest first is stable even when timestamps tie. `GET /api/jobs/:id`: return 404 `not_found` if it is missing.
8. **Server shutdown:** on SIGTERM or SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a 2 s fallback exit timer and `unref()` it.
9. **Worker startup:**
   - `openDatabase()`.
   - Recovery: `UPDATE jobs SET status='queued', progress_completed=0, run_after=0, updated_at=? WHERE status='running'`.
   - Write a heartbeat immediately with `INSERT … ON CONFLICT(id) DO UPDATE`, then repeat it every 1000 ms with `setInterval`. The step loop is async, so heartbeats keep going during processing.
10. **Worker loop:** while not stopping:
    - `SELECT * FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY seq LIMIT 1`.
    - If none, sleep 200 ms.
    - Claim it with `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`. Check `changes === 1`, then re-read the row.
11. **Processing an attempt** (`n = attempts`):
    - **If `n ≤ failAttempts`:** fail now, before any progress (an optional 100 ms sleep first is fine).
      - If `n < 3`: `status='queued', run_after=Date.now()+500`, progress stays 0, error stays NULL.
      - Otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - **Otherwise,** for i = 1..steps:
      - `await sleep(100)`.
      - If stopping, return and leave the job `running`. Recovery re-runs it on the next start.
      - `UPDATE progress_completed=i, updated_at`.
    - **After the last step:** `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Every status UPDATE also sets `updated_at`.
12. **Worker shutdown:** on SIGTERM or SIGINT, set `stopping`. The loop exits within about 100 ms. Clear the interval, optionally delete the heartbeat row, call `db.close()` and `process.exit(0)`. Add a 2 s fallback exit timer and `unref()` it.
13. **UI form** (`ui/index.html`): `<form data-testid="job-form" novalidate>` containing:
    - `<input data-testid="job-input" type="text">` with no `required`/`maxlength`, so the API does the validation
    - `<input data-testid="job-steps" type="number" value="5">` and `<input data-testid="job-fail-attempts" type="number" value="0">` with no min/max
    - `<button data-testid="job-submit" type="submit">`
    - `<div data-testid="form-error" role="alert"></div>`
    - `<ul data-testid="job-list">`
14. **UI submit:** call `preventDefault`. For each numeric field: if it is empty, omit it. Otherwise use `Number(v)`, and if that gives NaN, send the raw string so the API rejects it. POST with `Content-Type: application/json`.
    - On a non-2xx response, set `form-error` textContent to `error.message` plus one line per field: `"<field>: <message>"`.
    - On success, clear `form-error` and refresh right away.
15. **UI list:** poll every 1000 ms. Keep a `Map<id, li>` and update elements in place rather than rebuilding, so evaluator element handles stay valid. Order children newest first, following the API order.
    - Each `<li data-testid="job-item" data-job-id>` contains spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, otherwise empty).
    - Use `textContent` only, never innerHTML with user data.

## Behaviours to verify
- **Build and start:** run `npm run build && PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server` and start the worker in another shell with the same env. Start them in both orders. The dir `/tmp/jt` must get created.
- **Health:** `curl localhost:3100/health` shows `"worker":"up"` while the worker runs, and `down` about 3 s after killing it.
- **Create:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}'` → 201, queued, attempts 0, progress `0/2`.
- **Validation:** each of these gives 400 with the right `fields` entry:
  - `steps:"2"`, `failAttempts:7`, `colour:"blue"`, missing `input`, `"   "` input, a 1001-char input
  - body `[]`, body `nul`, no content-type, `text/plain`
  - `Idempotency-Key: bad key!`

  The job count must not change.
- **Idempotency:** the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` → 201 then 200 with the same id. A changed input → 409. Restart the server and replay → 200.
- **Processing:** poll `GET /api/jobs/:id` during a 20-step job and watch `progress.completed` rise. The final state is completed, `output` is uppercase, and progress is `20/20`.
- **Retries:** `failAttempts:1` → completed, attempts 2. `failAttempts:2` → attempts 3, completed. `failAttempts:3` → failed, `"transient failure"`, attempts 3, result null. In every case only one job exists in the list.
- **Crash recovery:** start a 20-step job, `kill -9` the worker mid-run, and restart it. The job completes. Completed jobs keep their `updated_at` unchanged.
- **Routing:** `DELETE /api/jobs` → 405, `GET /nope` → 404, `GET /api/jobs/zzz` → 404 `not_found`. All are JSON.
- **SIGTERM:** both processes exit with code 0 quickly.
- **Repo checks:** run `npm run check:smoke` and `npm run check:contract`.
- **UI:** open `/` in a browser. Submit `steps` 25 and check that `form-error` names `steps`. Submit a valid job and check that status and progress update without a reload.

## Risks
- **Lock contention:** without `busy_timeout` and short transactions you get SQLITE_BUSY. Keep the existing pragmas, and never hold a transaction across an `await`.
- **Ordering:** don't sort by `created_at` alone, because millisecond ties give the wrong order. Use `seq`.
- **Type coercion:** `Number.isInteger("3")` is false, but don't coerce first. Also check `typeof`.
- **Content-Type with a charset** (e.g. `application/json; charset=utf-8`) must be accepted.
- **Unknown fields:** don't stop at the first error. The checker looks for the specific field name (e.g. `colour`).
- **Idempotency races:** do the lookup and insert inside one `BEGIN IMMEDIATE` transaction. The UNIQUE constraint is a backstop: if the insert hits a constraint error, re-select and respond.
- **Crash-recovered attempts:** a job recovered after a crash gets one more attempt, and `attempts` counts it honestly. Failure is still decided by `n ≤ failAttempts`, and the job becomes `failed` once a failed attempt has `n ≥ 3`.
- **Heartbeat gaps:** the heartbeat must not be blocked by job processing. Use `setInterval` and async sleeps, never busy-waits.
- **Browser validation in the UI:** `required`, `min`, `max` or `maxlength` attributes would stop invalid values reaching the API, and the evaluator expects API errors in `form-error`. Use `novalidate` and no constraints.
- **Hanging on shutdown:** open intervals or keep-alive sockets can stop a process from exiting. Clear them and call `process.exit(0)` explicitly.
- **Paths:** the HTML is read via `new URL('../ui/index.html', import.meta.url)` relative to `dist/`, which works because `ui/` sits beside `dist/`. Keep that path.