# Plan

## Approach
Use one SQLite schema, created idempotently by both processes in `src/db.ts` (`CREATE TABLE IF NOT EXISTS`). It holds a `jobs` table and a single-row `worker_heartbeat` table. The server is a plain `node:http` router with strict validation and idempotency enforced by a UNIQUE key column. The worker polls every 200 ms, claims the oldest due queued job with one atomic `UPDATE … RETURNING`, runs its steps with about 100 ms sleeps, and writes progress after each step. It sends a heartbeat every 500 ms on a separate timer. On startup it requeues any `running` job, and on SIGTERM it requeues the job it is running. The UI is one static HTML file with vanilla JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). After the pragmas, run the schema DDL. Export shared helpers: `rowToJob(row)`, `nowIso()`, and the `Job` and row types.
- `src/server.ts`: rewrite with the router, body reading, validation, idempotency, health, UI serving and SIGTERM shutdown.
- `src/worker.ts`: rewrite with recovery, heartbeat, the claim/process loop, retries and SIGTERM handling.
- `ui/index.html`: form, error region, job list and polling script. All required `data-testid`s.
- (Optional) `src/validate.ts`: a pure validation function, if that keeps `server.ts` tidy. Relative imports must keep the `.ts` extension (tsconfig uses `rewriteRelativeImportExtensions`).

## Steps
1. **Schema** in `db.ts`:
   ```sql
   CREATE TABLE IF NOT EXISTS jobs (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL,
     input TEXT NOT NULL,
     steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0,
     result_output TEXT,
     error TEXT,
     run_after INTEGER NOT NULL DEFAULT 0,   -- epoch ms
     idempotency_key TEXT UNIQUE,
     payload TEXT NOT NULL,                  -- canonical JSON {input,steps,failAttempts}
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS jobs_status_seq ON jobs(status, seq);
   CREATE TABLE IF NOT EXISTS worker_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), beat_at INTEGER NOT NULL);
   ```
   `rowToJob` maps a row to the exact API shape:
   - `result`: `{output}` only when status is `completed`, otherwise `null`.
   - `error`: the string only when `failed`, otherwise `null`.
   - `progress`: `{completed: progress_completed, total: steps}`.
   - Timestamps come from `new Date().toISOString()`.
2. **Server helpers**:
   - `send(res, status, body)` always sets `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - `readBody(req)` collects chunks with a 1 MB cap. Over the cap, return 400 with `body`.
3. **Routing** (pathname from `new URL`):
   - `/`: GET serves the HTML. Other methods get 405.
   - `/health`: GET only.
   - `/api/jobs`: GET or POST.
   - `^/api/jobs/([^/]+)$`: GET only. Wrap `decodeURIComponent` in try/catch; on failure return 404.
   - Anything else: 404 `not_found`. A known path with the wrong method: 405 `method_not_allowed` with an `Allow` header.
   - Wrap the handler in try/catch and return 500 `internal_error` JSON.
4. **Validation** (collect all errors into `fields: [{field, message}]`):
   - `Idempotency-Key`: if the header is present and does not match `^[A-Za-z0-9_-]{1,128}$`, add field `Idempotency-Key`.
   - Content-Type: take the media type before `;`, trim and lowercase it. It must equal `application/json`. If it is missing or different, add `body` and stop parsing.
   - `JSON.parse` failure, or a body that is not a plain object (null, array or primitive): add `body`.
   - Each key not in {input, steps, failAttempts}: add that key's name.
   - `input`: `typeof === 'string'`, `length` 1–1000, `trim() !== ''`.
   - `steps`: if present (`!== undefined`), it must satisfy `typeof === 'number' && Number.isInteger && 1..20`. `null` and `"3"` are rejected.
   - `failAttempts`: same rule, range 0..5.
   - Any error gives 400 `invalid_request` and creates no job.
5. **Create job**:
   - Apply defaults, then build `payload = JSON.stringify({input, steps, failAttempts})` with a fixed key order.
   - With a key: run `BEGIN IMMEDIATE`, then `SELECT` by `idempotency_key`.
     - Found with the same payload: 200 with that job.
     - Found with a different payload: 409 `idempotency_conflict`.
     - Not found: INSERT, commit, 201.
   - Use try/finally to ROLLBACK on error.
   - Without a key: INSERT with `id = crypto.randomUUID()`, `status='queued'`, `run_after = 0`, and return 201 with the job.
6. **Reads**:
   - List: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs}`.
   - Get by id: the job, or 404 `not_found`.
   - Health: `worker` is `"up"` only if `Date.now() - beat_at < 3000`.
7. **Server shutdown**: on SIGTERM and SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a 2 s `setTimeout(...).unref()` fallback exit. Log the listening port to stdout.
8. **Worker startup**:
   - Open the db (the schema is created there).
   - Recovery: `UPDATE jobs SET status='queued', progress_completed=0, run_after=0, updated_at=? WHERE status='running'`.
   - Write a heartbeat immediately: `INSERT … ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`.
   - Then repeat the heartbeat with `setInterval(…, 500)`.
9. **Worker loop** (while not stopping):
   - Claim:
     ```sql
     UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
     WHERE seq = (SELECT seq FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY seq LIMIT 1)
     RETURNING *
     ```
   - If nothing was claimed, sleep 200 ms.
   - If `attempts <= fail_attempts`: sleep 100 ms (the first step), then:
     - if `attempts >= 3`: set `status='failed'`, `error='transient failure'`, `result_output=NULL`, `progress_completed=0`;
     - otherwise: set `status='queued'`, `run_after = Date.now() + 500`, `progress_completed=0`.
   - Otherwise, for each step i = 1..steps:
     - sleep 100 ms;
     - if stopping: requeue (`status='queued'`, `progress_completed=0`, `run_after=0`) and break;
     - otherwise: `UPDATE progress_completed=i, updated_at`.
   - After the last step: `status='completed'`, `result_output = input.toUpperCase()`, `progress_completed = steps`.
   - Every write sets `updated_at`.
10. **Worker shutdown**: on SIGTERM and SIGINT, set `stopping`. The loop exits within about 200 ms. Then clear the interval, `DELETE FROM worker_heartbeat`, `db.close()` and `process.exit(0)`.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` with three fields:
      - `<input data-testid="job-input" type="text">`
      - `<input data-testid="job-steps" type="text" inputmode="numeric" value="5">`
      - `<input data-testid="job-fail-attempts" type="text" inputmode="numeric" value="0">`
    - `<button data-testid="job-submit" type="submit">`.
    - `<div data-testid="form-error" role="alert"></div>`, empty by default.
    - `<ul data-testid="job-list">`.
    - Submit handler: `preventDefault`. For each numeric field:
      - trimmed value empty: omit the field;
      - else if `Number(v)` is finite: send the number;
      - otherwise: send the raw string, so the API rejects it with that field named.
    - POST with `Content-Type: application/json`. On a non-2xx response, set the form-error text to `error.message` plus one line per field, `"<field>: <message>"`. On success, clear form-error and the input, then refresh.
    - `refresh()`: fetch `/api/jobs` and rebuild `<li data-testid="job-item" data-job-id=…>`. Each item holds:
      - `job-status`: the status text;
      - `job-progress`: `completed/total`;
      - `job-result`: the output if completed, the error if failed, otherwise empty;
      - the input.
    - Use `textContent` only, never innerHTML with job data. Run `setInterval(refresh, 1000)` and call `refresh()` on load.
12. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`. Fix any failures.

## Behaviours to verify
- **Build and start**: run `npm run build`, then `PORT=3001 DATABASE_PATH=/tmp/jt/a.db npm run start:server` and `start:worker` in either order. `curl localhost:3001/health` shows `worker:"up"`. Within about 3 s of killing the worker it shows `"down"`.
- **Create and complete**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}' :3001/api/jobs` returns 201 queued with attempts 0. Polling `GET /api/jobs/<id>` shows progress going 1/3, 2/3, then completed with output `HI` and attempts 1.
- **Retries**: `failAttempts:1` ends completed with attempts 2. `failAttempts:2` ends with attempts 3. `failAttempts:3` ends failed with `"transient failure"`, attempts 3 and result null. There is still only one job in the list.
- **Validation**: each of these returns 400 with the named field:
  - `steps:"2"` → `steps`
  - `failAttempts:7` → `failAttempts`
  - `colour` → `colour`
  - missing input → `input`
  - `input:"   "` → `input`
  - `steps:2.5` → `steps`
  - malformed JSON, an array body, or no or `text/plain` Content-Type → `body`
  - bad `Idempotency-Key: a b` → `Idempotency-Key`

  The job count is unchanged afterwards.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` gives 201 then 200 with the same id. A different input gives 409. After a server restart, a replay still gives 200.
- **Routing**: `GET /nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `GET /api/jobs/xyz` → 404. Every response carries a JSON content type.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job completes within a few seconds. Completed jobs keep the same attempts and `updatedAt`.
- **SIGTERM**: `kill -TERM` exits both processes with code 0 within about 1 s.
- **UI**: open `/`. Submit and watch the status and progress update without a reload. Submit steps `50`: form-error shows `steps`. After a valid submit, form-error is empty.

## Risks
- **HTML5 validation blocking submission**: `required`, `min`/`max` or `type=number` attributes stop the request from reaching the API, so form-error stays empty. Use `novalidate` and text inputs as described.
- **Schema race**: both processes create the schema at the same moment. Keep busy_timeout before WAL and use `IF NOT EXISTS` everywhere.
- **Progress not visible**: `DatabaseSync` calls are synchronous. Don't wrap the whole job in one transaction; commit each progress update on its own (autocommit).
- **Heartbeat stalls**: the heartbeat must not depend on the job loop. Use `setInterval`; the async sleeps let it fire.
- **Validation edge cases**: `typeof null === 'object'` and arrays are objects, so check them explicitly. `steps: null` must be rejected, not treated as the default; only `undefined` gets the default.
- **Idempotency comparison**: compare against the canonical payload built after defaults are applied, not the raw body.
- **Result and error leaking**: never return `result` for non-completed jobs or `error` for non-failed jobs. Derive both from status in `rowToJob`.
- **Retry deadlock**: a retry waiting on `run_after` must not block other queued jobs. The claim query filters on `run_after <= now`, so it doesn't. Keep the retry delay at 500 ms, inside the 250 ms–2 s window.
- **Import paths**: the UI path `new URL('../ui/index.html', import.meta.url)` resolves from `dist/`. Keep it and keep `.ts` import extensions, or the build or runtime breaks.