# Plan

## Approach
Keep the existing layout: `src/db.ts` handles the shared schema and data access, `src/server.ts` is the `node:http` API plus static UI, `src/worker.ts` is a polling worker loop, and `ui/index.html` is a self-contained page with inline JS. All state lives in SQLite through `node:sqlite` `DatabaseSync`. This includes a `jobs` table (with a scheduled `run_after` time for retries, plus an idempotency key and canonical payload) and a `worker_heartbeat` row. The worker claims jobs inside `BEGIN IMMEDIATE` transactions. It updates progress after each step, and when it starts it re-queues any job left `running` by a crashed worker. The server is synchronous against SQLite, so idempotent create (lookup, then insert) runs inside one transaction and a UNIQUE index on the key backs it up.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `migrate(db)` with `CREATE TABLE IF NOT EXISTS`. Add a row→JSON `toJob()` mapper and shared helpers (`nowIso`, the heartbeat key).
- `src/server.ts`: rewrite. Routing, validation, idempotency, error shape, health, UI serving, SIGTERM shutdown.
- `src/worker.ts`: rewrite. Heartbeat, crash recovery, claim loop, step processing, retries, SIGTERM shutdown.
- `ui/index.html`: form, error region and job list with all required `data-testid`s, plus a 1 s polling renderer.

## Steps
1. **Schema** (`migrate`, called by both processes at startup; safe to run concurrently because of IF NOT EXISTS and busy_timeout):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE, payload TEXT);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_ms INTEGER NOT NULL);
   ```
   `toJob(row)` returns exactly the JSON shape in the task. `result` is `{output}` only when status is `completed` (else null). `error` is null unless status is `failed`. `progress` is `{completed: progress_completed, total: steps}`. Order newest first with `ORDER BY seq DESC`, because createdAt can tie.
2. **Server helpers**: `send(res, status, body)` always sets `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)`. Read the body as a Buffer with a size cap (e.g. 1 MB; if exceeded, return 400 with field `body`).
3. **Routing** (parse with `new URL`, ignore the query string):
   - `/` GET serves the HTML.
   - `/health` GET.
   - `/api/jobs` GET or POST.
   - `/^\/api\/jobs\/([^/]+)$/` GET (decodeURIComponent inside try).

   A known path with any other method returns 405 `method_not_allowed`. Everything else returns 404 `not_found`. A missing job id returns 404 `not_found`. Wrap the handler in try/catch and return 500 `internal_error` JSON.
4. **Health**: `SELECT beat_ms FROM worker_heartbeat WHERE id=1`. Return `worker: "up"` if `Date.now() - beat_ms < 3000`.
5. **POST validation**: collect `fields[]` and don't stop at the first error.
   - Content-Type: parse the media type before `;`, lowercase it, and require `application/json`. If it's wrong or missing, add `{field:"body"}` and skip body parsing.
   - Idempotency-Key header present but not matching `^[A-Za-z0-9_-]{1,128}$`: add `{field:"Idempotency-Key"}`.
   - `JSON.parse`. On a throw, add `body`. If the value is not a plain object (null, array or primitive), add `body`.
   - Each key not in {input, steps, failAttempts} is reported under its own name.
   - `input`: must be a string with `1 ≤ length ≤ 1000` and `input.trim() !== ''`. Missing input gets field `input`.
   - `steps` and `failAttempts`: if present they must be `typeof === 'number' && Number.isInteger(v)` and within range. Absent means the default (5 or 0). Treat explicit `null` as invalid.
   - If any field failed, return 400 `invalid_request` with message "Invalid request" and the `fields` list.
6. **Create**: build the canonical payload with fixed key order, `JSON.stringify({input, steps, failAttempts})`. In `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on error):
   - If a key was given, `SELECT * FROM jobs WHERE idempotency_key=?`. If a row exists and its payload equals the new payload, return 200 with that job. If the payload differs, return 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = crypto.randomUUID()`, status `queued`, attempts 0, `created_at = updated_at = new Date().toISOString()`, `run_after = 0`, and the key and payload (key NULL if absent). Return 201.
7. **Server shutdown**: on SIGTERM/SIGINT call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`, with a 2 s fallback exit. Log `server listening on ${port}` once listening.
8. **Worker startup**: open the DB, migrate, write the heartbeat right away (`INSERT … ON CONFLICT(id) DO UPDATE SET beat_ms=excluded.beat_ms`), then repeat it with `setInterval` every 1000 ms (`unref` not needed; clear it on shutdown). Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. Decrementing counts the interrupted attempt as not counted, so `attempts` never goes above 3. Only one worker exists, so any `running` row is orphaned.
9. **Claim** (poll every ~200 ms while idle): in `BEGIN IMMEDIATE`, run `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq ASC LIMIT 1`. If a row is found, `UPDATE … SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`, then COMMIT.
10. **Process attempt** with `n` = the new attempts value:
    - If `n <= fail_attempts`: if `n >= 3`, set `status='failed'`, `error='transient failure'`, `result_output=NULL`. Otherwise set `status='queued'`, `run_after=Date.now()+500`, `progress_completed=0`. Update `updated_at` in both cases.
    - Otherwise, for i = 1..steps: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. If `stopping`, break. After the loop: `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`, `error=NULL`.
    - Every status-changing UPDATE includes `WHERE id=? AND status='running'`.
11. **Worker shutdown**: SIGTERM/SIGINT sets `stopping`. If a job is mid-run, re-queue it the same way recovery does (status queued, attempts-1, progress 0). Then clear the interval, `db.close()` and exit 0. Use short sleeps so the worker exits in well under a second.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - `<div data-testid="form-error" role="alert"></div>`
    - `<ul data-testid="job-list">`
    - On submit (`preventDefault`): input is sent as a raw string. For the numeric fields, an empty value is omitted, a value whose `Number(v)` is finite is sent as that number, and anything else is sent as the raw string so the API rejects it. POST with the JSON Content-Type.
    - If the response is not OK, show `error.message` plus one line per `fields[]` entry (`field: message`) with textContent. If OK, clear the error, reset the input and refresh the list right away.
    - Refresh: `setInterval(refresh, 1000)` fetches `/api/jobs` and renders an `<li data-testid="job-item" data-job-id>` per job with `<span data-testid="job-status">`, `<span data-testid="job-progress">` showing `c/t`, and `<span data-testid="job-result">`. The result span holds the output if completed, the error if failed, otherwise ''. Use textContent only. Re-rendering the list only must leave form state untouched.

## Behaviours to verify
Run `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server` and `start:worker` in two terminals. Also run `npm run check:smoke` and `npm run check:contract` (see `checks/cli.ts` for how they locate the server).
- **Create and get**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}'` returns 201, queued, attempts 0, progress 0/2. GET by id works, and the list is newest first.
- **Validation**: `{"input":"x","steps":"2"}` gives 400 with field steps. `failAttempts:7` gives failAttempts. Unknown `colour` gives colour. A missing input gives input. Also check malformed JSON, `[]`, a text/plain Content-Type, a bad key `a b`, a whitespace-only input and `steps:1.5`. Afterwards the job count is unchanged.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 200 with the same id. Changing the input returns 409. A replay after restarting the server still returns 200.
- **Processing**: poll GET and see progress rise 0→N about every 100 ms. The job ends `completed` with output uppercased and attempts 1.
- **Retries**: `failAttempts:1, steps:1` completes with attempts 2. `failAttempts:2` gives attempts 3. `failAttempts:3` ends `failed` with error "transient failure", result null and attempts 3. Only one job is listed in each case.
- **Health**: `worker:"up"` with the worker running, and `"down"` within about 3 s of killing it.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run and restart it. The job completes and nothing is lost. Repeat with both processes killed.
- **SIGTERM**: both processes exit promptly with code 0.
- **Routing**: `DELETE /api/jobs` gives 405, `/nope` gives 404 `not_found`, and every response is JSON.
- **UI**: open `/`, submit, and watch status and progress update with no reload. Submit an empty input or steps 99 and `form-error` names the field.

## Risks
- **Browser validation**: without `novalidate` (or with `required`, `min` or `max` attributes), the browser blocks invalid submissions and `form-error` never shows the API's rejection. Keep `novalidate`.
- **Numeric strings**: don't coerce `"3"` on the server. Check `typeof` strictly.
- **Idempotency comparison**: compare the canonical payload *after defaults*, built with a fixed key order. Don't compare the raw body.
- **Lock contention**: a SQLITE_BUSY error can crash a process. Keep busy_timeout, keep transactions short, and always ROLLBACK in `finally` on error.
- **Attempts above 3 after a crash**: avoid this with the decrement in recovery and graceful shutdown. Never reprocess `completed` or `failed` jobs, so recovery only touches `running`.
- **Ordering**: sort by `seq`, never by the `createdAt` string, for both newest-first lists and oldest-first claims.
- **Content-Type**: it may arrive as `application/json; charset=utf-8`, so parse the media type rather than doing an equality check.
- **UI path**: `dist/server.js` loads `../ui/index.html` via `import.meta.url`. Keep that path working, and keep relative imports with the `.ts` extension, because `rewriteRelativeImportExtensions` is enabled.
- **Shutdown hangs**: open intervals or keep-alive sockets can stop a process from exiting. Clear timers, close connections and add a fallback `process.exit`.