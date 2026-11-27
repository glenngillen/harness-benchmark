# Plan

## Approach
Keep the existing three-file layout: `src/db.ts` holds the schema and shared helpers, `src/server.ts` is the HTTP API and serves the UI, and `src/worker.ts` is the polling worker. Use only `node:sqlite` `DatabaseSync` in WAL mode with the existing busy_timeout. All multi-statement read-then-write logic runs inside `BEGIN IMMEDIATE … COMMIT`, so the two processes can never race. Never hold a transaction open across an `await`. The worker claims jobs atomically, writes progress after each step, schedules retries with a `run_after` timestamp column, and writes a heartbeat row every 500 ms. `ui/index.html` is a self-contained vanilla-JS page that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` for `jobs` and `heartbeat`, plus `rowToJob(row)` (DB row → API JSON shape) and a `tx(db, fn)` helper (BEGIN IMMEDIATE / COMMIT / ROLLBACK on throw).
- `src/server.ts`: rewrite. Routing, body reading, validation, idempotency, health, UI, and SIGTERM handling.
- `src/worker.ts`: rewrite. Heartbeat, crash recovery, claim loop, step processing, retries, and SIGTERM handling.
- `ui/index.html`: form, error region, job list, and inline script.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
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
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,  -- epoch ms
     idempotency_key TEXT UNIQUE,
     payload TEXT NOT NULL                  -- canonical JSON
   );
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
   ```
   - Both processes run this, which is safe because of `IF NOT EXISTS` and busy_timeout.
   - `rowToJob` returns exactly: `id, status, input, steps, failAttempts, attempts, progress:{completed,total:steps}, result: result_output!=null && status==='completed' ? {output} : null, error, createdAt, updatedAt`.
   - Generate IDs with `crypto.randomUUID()` and timestamps with `new Date().toISOString()`.
2. **Server helpers:**
   - `send(res, status, body)` as it is now.
   - `sendError(res, status, code, message, fields?)`.
   - `readBody(req)` collects chunks into a utf8 string. Cap it at about 1 MB; past that, respond `400 invalid_request` with field `body`.
3. **Routing** (on `pathname`):
   - `/health` → GET only.
   - `/` → GET only (serve the HTML; read `ui/index.html` at startup, path relative to `import.meta.url` as now, so it resolves from `dist/`).
   - `/api/jobs` → GET or POST.
   - `/api/jobs/<id>` (regex `^/api/jobs/([^/]+)$`, decodeURIComponent inside a try) → GET only.
   - A known path with another method → `405 method_not_allowed` with an `Allow` header. Anything else → `404 not_found`.
   - Wrap the handler in try/catch: on an unexpected error, return `500 internal_error` JSON.
4. **POST validation.** Collect `fields[]` and return one 400 that lists all of them.
   - `Idempotency-Key` header present and not matching `^[A-Za-z0-9_-]{1,128}$` → field `"Idempotency-Key"`. An empty string counts as present and invalid.
   - Content-Type: take the part before `;`, trim, lowercase. It must equal `application/json`. If it is missing or different → field `body`, message "Content-Type must be application/json". Stop body checks there.
   - `JSON.parse` fails → `body`. Parsed value is not a plain object (null, array, or primitive) → `body`.
   - Any key other than input/steps/failAttempts → a field entry with that key's name ("unknown field").
   - `input` must be `typeof === 'string'`, with `length` from 1 to 1000 and `trim() !== ''`. If missing or invalid → field `input`. Store it exactly as sent; do not trim.
   - `steps` / `failAttempts`: if the key is absent, use the default (5 / 0). If present, it must satisfy `typeof v === 'number' && Number.isInteger(v)` and be in range (1–20 / 0–5); otherwise list the field. `null`, `"3"`, and `2.5` are all rejected.
5. **Create plus idempotency**, inside `tx` (BEGIN IMMEDIATE):
   - `payload = JSON.stringify({input, steps, failAttempts})` in fixed key order.
   - If there is a key, `SELECT * FROM jobs WHERE idempotency_key=?`. If found: same payload → `200` with that job; different payload → `409 idempotency_conflict`.
   - Otherwise INSERT with status `queued`, attempts 0, progress 0, run_after 0, both timestamps now → `201`.
   - The UNIQUE constraint is a backstop. As an extra guard, catch a constraint error and re-select.
6. **GET routes:**
   - The list uses `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. Use `seq`, not `created_at`, because timestamps can tie.
   - A single job: select by id, or `404 not_found`.
7. **Health:** `SELECT last_seen FROM heartbeat WHERE id=1`. `worker` is `'up'` if the row exists and `Date.now() - last_seen < 3000`, otherwise `'down'`.
8. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a fallback `setTimeout(() => process.exit(0), 2000).unref()`.
9. **Worker startup:**
   - Open the DB and start `setInterval(beat, 500)`, where `beat` does `INSERT INTO heartbeat(id,last_seen) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`. Call `beat()` immediately too.
   - **Recovery:** in a transaction, `UPDATE jobs SET status='queued', progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. This assumes a single worker, so any `running` row is orphaned.
10. **Claim loop** (while not stopping):
    - In `tx`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`. If found, compute `n = min(attempts+1, 3)`, then `UPDATE ... SET status='running', attempts=n, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`.
    - The `min` means a crash-recovered job that already used 3 attempts reruns as attempt 3 and never goes past 3.
    - If nothing was claimed, sleep 200 ms.
11. **Process an attempt** (number `n`):
    - Sleep 100 ms, the first step's time.
    - If `n <= fail_attempts`, the attempt fails:
      - if `n < 3`: `status='queued', progress_completed=0, run_after=now+500`;
      - otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - Otherwise loop `i = 1..steps`: sleep 100 ms (sleep only once for step 1, since the pre-sleep already covered it), then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps.
    - At the end, in a single UPDATE: `status='completed', result_output=input.toUpperCase(), progress_completed=steps, error=NULL`.
    - Guard every UPDATE with `WHERE id=? AND status='running'`.
12. **Worker SIGTERM:**
    - Set `stopping=true`. If a job is mid-attempt, the loop exits early and runs `UPDATE jobs SET status='queued', progress_completed=0, run_after=0 WHERE id=? AND status='running'`.
    - Then clear the interval, set heartbeat `last_seen=0`, `db.close()`, and `process.exit(0)`.
    - Use an abortable sleep or a short step sleep so exit happens within about 500 ms. Add a fallback `setTimeout(exit, 3000).unref()`.
13. **UI** (`ui/index.html`):
    - Markup:
      - `<form data-testid="job-form" novalidate>` containing:
        - `<input data-testid="job-input" name="input">` with no `maxlength` or `required`;
        - `<input type="number" data-testid="job-steps" value="5">`;
        - `<input type="number" data-testid="job-fail-attempts" value="0">`;
        - `<button type="submit" data-testid="job-submit">`.
      - `<div data-testid="form-error" role="alert"></div>`, initially empty.
      - `<ul data-testid="job-list">`.
    - On submit: `preventDefault`. Convert each numeric field with `v.trim()==='' ? undefined : (isFinite(Number(v)) ? Number(v) : v)`; omit undefined, send numbers as numbers, and send unparsable text raw so the API rejects it. POST with `Content-Type: application/json`.
    - On non-2xx, set the error region's `textContent` to `error.message` plus one line per field (`field: message`). On success, clear it, clear the input, and refresh immediately.
    - Every 1000 ms (and once on load): `GET /api/jobs` and render each job as `<li data-testid="job-item" data-job-id=id>` with `<span data-testid="job-status">`, `<span data-testid="job-progress">` (`completed/total`), and `<span data-testid="job-result">` (`result.output`, or `error`, or empty).
    - Build nodes with `textContent` only (no innerHTML with user data). Keep the API's newest-first order.

## Behaviours to verify
After `npm run build`, run `DATABASE_PATH=/tmp/t/jobs.db PORT=3100 npm run start:server` and `start:worker` in two terminals, then:
- **Health:** `curl :3100/health` shows `worker:"up"`. Kill the worker; within about 3 s it shows `"down"`.
- **Create and complete:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"hello","steps":3}'` returns 201 with status queued, attempts 0, progress `0/3`. Polling GET shows progress rising, then completed with `HELLO` and attempts 1.
- **Validation:** each of the following returns 400 with the named field:
  - `steps:"2"` → `steps`;
  - `failAttempts:7` → `failAttempts`;
  - `colour` → `colour`;
  - missing input → `input`;
  - `input:"   "` → `input`;
  - text/plain or missing Content-Type → `body`;
  - `{bad json` → `body`;
  - `[]` → `body`;
  - `Idempotency-Key: a b` → `Idempotency-Key`.

  The job count must not change.
- **Idempotency:** with the same key, `{"input":"a"}` followed by `{"input":"a","steps":5,"failAttempts":0}` returns 200 with the same id. A different input with that key returns 409. Restart the server and replay: still 200 with the same id.
- **Retries:** `failAttempts:1` → completed with attempts 2. `failAttempts:2` → completed with attempts 3. `failAttempts:3` → failed, error `"transient failure"`, attempts 3, result null. Only one job per input in the list.
- **Routing:** `GET /nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `GET /api/jobs/xyz` → 404.
- **Crash recovery:** submit `steps:20` and `kill -9` the worker mid-run. The job is still `running`; after a restart it completes within a few seconds. Completed jobs are never touched again: their `updatedAt` stays unchanged.
- **Durability:** `kill -9` both processes and restart them. All jobs are still listed.
- **SIGTERM:** `kill -TERM` on each process exits promptly with code 0.
- **Checks:** `npm run check:smoke` and `npm run check:contract` pass.
- **UI:** open `/` and submit `steps` = 99; the error region shows `steps`. A valid job shows its status and progress changing without a reload.

## Risks
- **Holding a transaction across `await`** would block the other process (SQLITE_BUSY). Keep every `tx` callback synchronous.
- **Browser constraint validation** (`min`/`max`/`required`) would stop the form before the API sees it. Use `novalidate` and no `maxlength`, so API errors appear in `form-error`.
- **Typeof checks:** `typeof null === 'object'` and arrays are objects. Explicitly reject `null`/arrays as the body, and reject an explicit `null` for steps/failAttempts.
- **Content-Type with parameters** (`application/json; charset=utf-8`) must be accepted. Compare only the media type, case-insensitively.
- **Newest-first ordering** must use `seq` (AUTOINCREMENT), not ISO timestamps, which can collide within the same millisecond.
- **Attempt counts:** don't let attempts exceed 3 during crash recovery, and don't increment attempts on recovery itself. Only claiming increments it.
- **Imports:** keep the `.ts` extensions in imports (`./db.ts`). `rewriteRelativeImportExtensions` rewrites them for `dist/`. Don't import anything outside `src/` from TS.
- **Heartbeat timing:** the worker must start the heartbeat before any long work, and its interval must keep running while steps sleep. Steps use async sleeps, so it will. Never use a busy loop.
- **Response format:** every response other than the HTML page must be JSON with `application/json`, including 404, 405 and 500.