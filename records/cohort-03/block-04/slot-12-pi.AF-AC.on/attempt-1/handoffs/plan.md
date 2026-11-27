# Plan

## Approach
Use one SQLite schema, created idempotently by `openDatabase()` in both processes. It holds a `jobs` table (autoincrement `seq` for ordering, UUID `id`, and a unique nullable `idempotency_key` with its canonical payload) and a single-row `heartbeat` table. The server is a plain `node:http` router with strict validation. Idempotency is enforced inside a `BEGIN IMMEDIATE` transaction backed by the UNIQUE constraint. The worker is a polling loop that claims the oldest eligible queued job in a transaction, runs its steps with `await sleep(100)`, and writes progress after each step. A separate interval writes the heartbeat. Crash recovery happens at worker startup: any `running` job goes back to `queued`. The UI is a single static HTML file with vanilla JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for the schema, plus shared helpers: the `JobRow` type, `rowToJob(row)` that builds the API shape, and `nowIso()`.
- `src/server.ts`: router, body reading, validation, idempotency, health, SIGTERM handling.
- `src/worker.ts`: heartbeat, recovery, claim/process loop, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling script. The server already loads it from `../ui/index.html` relative to `dist/server.js`; keep that.

## Steps
1. **Schema** in `db.ts`, run on every open:
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT,
     next_run_at INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
   ```
   `rowToJob` returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Use `new Date().toISOString()` for timestamps. Keep the `.ts` extension in relative imports, because tsconfig rewrites them.
2. **Server helpers**: `send(res, status, body)` always sets `application/json; charset=utf-8`. Add `sendError(res, status, code, message, fields?)`.
3. **Routing** on `pathname`:
   - `/` GET → HTML.
   - `/health` GET.
   - `/api/jobs` GET or POST.
   - `/api/jobs/:id` (regex `^/api/jobs/([^/]+)$`) GET.
   - A known path with the wrong method → 405 `method_not_allowed`.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **Health**: `SELECT at FROM heartbeat WHERE id=1`. `worker` is `"up"` if the row exists and `Date.now()-at < 3000`.
5. **POST validation**. Collect `fields[]` and do not stop at the first error:
   - Read the full body as a utf8 string.
   - Content-Type: missing, or its media type (before `;`, trimmed, lowercased) is not `application/json` → field `body`.
   - `Idempotency-Key` header present but failing `/^[A-Za-z0-9_-]{1,128}$/` → field `Idempotency-Key`. Validate this alongside the body errors.
   - If Content-Type is OK: `JSON.parse` in try. On failure → `body`. If the result is not a plain object (`null`, array, primitive) → `body`.
   - If it is an object: any key outside `input`, `steps`, `failAttempts` → that key's name.
   - `input` must be `typeof 'string'`, `length` 1–1000, and `trim().length > 0`. Store it untrimmed.
   - `steps` and `failAttempts`, if present (`!== undefined`), must be `typeof 'number' && Number.isInteger && in range`. Otherwise the field errors. Defaults are 5 and 0. `null` is invalid.
   - If any errors → 400 `{error:{code:'invalid_request', message:'Invalid request', fields}}`.
6. **Creation and idempotency**: `payload = JSON.stringify({input, steps, failAttempts})` (fixed key order). Inside `BEGIN IMMEDIATE … COMMIT`, with ROLLBACK on error:
   - If there is a key and a row has that key: same `payload` → 200 with that job, otherwise 409 `idempotency_conflict`.
   - Otherwise INSERT with `id=randomUUID()`, `status='queued'`, `next_run_at=0`, then return 201.
   - Store `idempotency_key` NULL when the header is absent.
7. **List and get**: `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs}`. Get by id → 200, or 404 `not_found`.
8. **Server shutdown**: on SIGTERM/SIGINT, `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`.
9. **Worker startup**:
   - Open the db.
   - Write the heartbeat immediately (`INSERT … ON CONFLICT(id) DO UPDATE SET at=excluded.at`), then every 500 ms via `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, next_run_at=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run under the same number, so `attempts` never goes above 3 and pass/fail stays deterministic. Log `worker started`.
10. **Worker loop**, `while (!stopping)`:
    - Claim inside `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND next_run_at<=? ORDER BY seq LIMIT 1`. If a row is found, `UPDATE … SET status='running', attempts=attempts+1, progress=0, updated_at=? WHERE id=?`, then COMMIT.
    - No job → `await sleep(200)`.
    - Process with `n = attempts` (after the increment):
      - If `n <= fail_attempts`: `await sleep(100)`. Then, if `n >= 3`, set `status='failed', error='transient failure', result_output=NULL`. Otherwise set `status='queued', progress=0, next_run_at=Date.now()+500`.
      - Otherwise, for i in 1..steps: `await sleep(100)`. If `stopping`, abort (see step 11). Then `UPDATE progress=i, updated_at`.
      - At the end: `status='completed', result_output=input.toUpperCase(), progress=steps`.
    - Put `AND status='running'` on all of these updates.
11. **Worker shutdown**: SIGTERM/SIGINT sets `stopping=true`. If a job is mid-flight, put it back the same way recovery does (queued, `attempts-1`, progress 0). Then `clearInterval`, optionally `DELETE FROM heartbeat`, `db.close()`, `process.exit(0)`. The worker must exit well within 5 s; a step is at most 100 ms.
12. **UI** (`ui/index.html`):
    - Markup:
      - `<form data-testid="job-form" novalidate>`.
      - `<input data-testid="job-input">`.
      - `<input type="text" inputmode="numeric" data-testid="job-steps" value="5">`.
      - `<input type="text" inputmode="numeric" data-testid="job-fail-attempts" value="0">`.
      - `<button type="submit" data-testid="job-submit">`.
      - `<div data-testid="form-error" role="alert"></div>`.
      - `<ul data-testid="job-list">`.
    - Submit handler: call `preventDefault`. Build the body with `input` as the raw value. For each numeric field: empty → omit it; else `n=Number(v.trim())`, send `n` if `Number.isFinite(n)`, otherwise send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, fill `form-error` via `textContent`/DOM nodes: the message plus one line per `fields` entry (`field: message`).
    - On success, clear `form-error`, clear the input, and refresh immediately.
    - `refresh()` fetches `/api/jobs` every 1000 ms. For each job it renders `<li data-testid="job-item" data-job-id=id>`, containing spans `job-status` (status), `job-progress` (`${completed}/${total}`), and `job-result` (`result.output`, or `error`, or empty), plus the input text.
    - Use `textContent` only; never innerHTML with user data.

## Behaviours to verify
- Build/run: `npm run build && npm run check:smoke && npm run check:contract`. Both must pass.
- Health: start only the server → `worker:"down"`. Start the worker → `"up"` within 1 s. Kill the worker → `"down"` after about 3 s.
- Validation: with curl, test `steps:"3"`, `steps:2.5`, `steps:0`, `failAttempts:6`, an unknown field, `input:"   "`, an input of 1001 chars, the body `[]`, the body `{bad`, a missing Content-Type, `text/plain`, and `Idempotency-Key: a b`. Each must give 400 with the right `fields[].field` and leave the job count unchanged.
- Defaults and idempotency: POST `{"input":"a"}` with key K → 201. Then `{"input":"a","steps":5,"failAttempts":0}` with K → 200 with the same id. Then `{"input":"b"}` with K → 409. Restart the server and replay → still 200, same id.
- Progress: POST `steps:20` and poll `GET /api/jobs/:id` every 150 ms. You should see `running` with increasing `progress.completed`, then `completed` with output `INPUT`.
- Retries: `failAttempts:1` → completed, attempts 2. `failAttempts:2` → completed, attempts 3. `failAttempts:3` → failed, attempts 3, `error:"transient failure"`, `result:null`.
- Crash recovery: POST `steps:20`, then `kill -9` the worker while the job is running. Status stays `running`. Restart the worker → the job completes within a few seconds and `attempts` is 1. Completed jobs are untouched.
- SIGTERM: `kill -TERM` each process. Each exits 0 promptly.
- UI: open `/`, submit a valid job and watch status/progress update without reload. Submit steps `abc` or `99` → `form-error` shows `steps`.

## Risks
- **npm signal wrapping**: `npm run` wraps node, and the check runner signals the process group, so handlers must call `process.exit(0)` and not hang on open handles (the interval, keep-alive sockets). Use `closeAllConnections()`.
- **SQLITE_BUSY between processes**: keep `busy_timeout`. Use `BEGIN IMMEDIATE` for claim and create. Never hold a transaction open across an `await`.
- **Ordering ties**: equal `createdAt` values in the same millisecond can break "newest first". Order by `seq`, not by `created_at`.
- **Attempt counting**: retry delays must keep the job `queued` with `next_run_at`, not sleep while still `running`. Recovery must not push `attempts` past 3; that is why it decrements.
- **Validation edge cases**: `typeof NaN === 'number'`, but JSON can't produce NaN, so `Number.isInteger` is enough. Reject `null` values and arrays as bodies. Content-Type `application/json; charset=utf-8` must be accepted.
- **Browser validation in the UI**: `type=number` with min/max would let the browser block a submission before it reaches the API, and Playwright can't fill non-numeric text into it. Use text inputs with `novalidate`.
- **Unexpected exceptions**: return JSON 500 rather than crashing. Use `rowToJob` everywhere so all endpoints return the same shape.