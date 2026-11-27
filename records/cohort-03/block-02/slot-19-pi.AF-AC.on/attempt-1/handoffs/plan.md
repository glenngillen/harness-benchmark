# Plan

## Approach
Use one SQLite schema, shared through `src/db.ts`. It holds a `jobs` table and a single-row `worker_heartbeat` table. Both processes call an idempotent `initSchema()` on startup, so either one can start first. The server is a plain `node:http` router with strict validation. Idempotency rests on a UNIQUE `idempotency_key` column plus a stored canonical payload, and the check runs inside a `BEGIN IMMEDIATE` transaction. The worker is a polling loop. It claims the oldest runnable queued job in a transaction, runs the steps with progress writes, handles retries through an `available_at` timestamp, writes a heartbeat every 1 s, and on startup re-queues jobs left `running`. The UI is one static HTML file with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (busy_timeout + WAL). Add `initSchema(db)`, the `JobRow` type, `rowToJob(row)` (builds the API JSON shape) and `nowIso()`.
- `src/server.ts`: rewrite. Add the router, body reading, validation, idempotency, health, UI serving and SIGTERM handling.
- `src/worker.ts`: rewrite. Add the heartbeat, startup recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: the full page with the required `data-testid`s and inline script. It stays at this path because the server reads `../ui/index.html` relative to `dist/server.js`.

## Steps
1. **Schema** in `initSchema`, using `CREATE TABLE IF NOT EXISTS`:
   - `jobs`:
     - `seq INTEGER PRIMARY KEY AUTOINCREMENT`
     - `id TEXT UNIQUE NOT NULL` (`crypto.randomUUID()`)
     - `status TEXT`, `input TEXT`, `steps INT`, `fail_attempts INT`, `attempts INT DEFAULT 0`, `progress_completed INT DEFAULT 0`
     - `result_output TEXT NULL`, `error TEXT NULL`
     - `idempotency_key TEXT UNIQUE NULL`, `payload TEXT` (canonical JSON `{"input","steps","failAttempts"}` in fixed key order)
     - `available_at INTEGER` (epoch ms), `created_at TEXT`, `updated_at TEXT`
     - Index on `(status, available_at, seq)`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER)`.
   - Wrap init in try/catch-retry, or rely on `busy_timeout`. Keep the busy_timeout-before-WAL order.
2. **rowToJob**: returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total:steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
3. **Server helpers**:
   - `send(res, status, body)` always uses `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body as a Buffer, capped at about 1 MB (over the cap gives 400 with field `body`).
4. **Routing**, matched on `pathname`:
   - `/` accepts GET (HTML) only.
   - `/health` accepts GET only.
   - `/api/jobs` accepts GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` accepts GET only.
   - Any other method on a known path → 405 `method_not_allowed`. Any unknown path → 404 `not_found`.
   - Wrap the handler in try/catch → 500 `internal_error`.
5. **POST validation**: collect every error into `fields[]`, then return 400 `invalid_request` if any were found.
   - **Content-Type**: take the media type, split on `;`, trim and lowercase it. It must equal `application/json`; otherwise add a `body` error.
   - **Body**: `JSON.parse` failure, or a result that is not a plain object (null, array or primitive) → field `body`.
   - **Unknown keys** → one entry per key name.
   - **`input`**: missing, or not `typeof === 'string'`, or length 0 or over 1000, or `trim()===''` → field `input`.
   - **`steps` / `failAttempts`**: an absent key (`undefined`) takes the default. Any present value must satisfy `typeof v==='number' && Number.isInteger(v)` and be in range. Explicit `null` and `"3"` are invalid.
   - **`Idempotency-Key` header**: if present (`req.headers['idempotency-key']`), it must match `^[A-Za-z0-9_-]{1,128}$`, else field `Idempotency-Key`. Validate it together with the body.
6. **Create the job** inside `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on throw):
   - If a key was sent, `SELECT` by `idempotency_key`. If found and `payload` equals the canonical payload → 200 with that job. If found with a different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT with `status='queued'`, `attempts=0`, `progress=0`, `available_at=Date.now()` and the same ISO timestamp for created and updated. Return 201.
   - The UNIQUE constraint backs this up across restarts.
7. **GET routes**:
   - `GET /api/jobs`: `ORDER BY seq DESC` (timestamps can tie, so don't sort by them) → `{jobs}`.
   - `GET /api/jobs/:id`: `decodeURIComponent` the id, then 200 with the job or 404 `not_found`.
   - `/health`: `worker` is `'up'` if `Date.now() - last_seen <= 3000`.
8. **Server shutdown**: on SIGTERM/SIGINT call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Log once listening.
9. **Worker startup**:
   - `openDatabase`, `initSchema`, then write the heartbeat immediately.
   - `setInterval` every 1000 ms to upsert the heartbeat (`INSERT … ON CONFLICT(id) DO UPDATE`).
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, available_at=now WHERE status='running'`. The interrupted attempt is re-run under the same number, so `attempts` never goes above 3 and the failAttempts behaviour stays deterministic.
10. **Worker loop** (`while(!stopping)`):
    - **Claim** in `BEGIN IMMEDIATE`: `SELECT … WHERE status='queued' AND available_at<=? ORDER BY seq ASC LIMIT 1`, then `UPDATE SET status='running', attempts=attempts+1, progress_completed=0, updated_at`.
    - If nothing was claimed, sleep 200 ms.
    - **Process attempt n**: if `n <= fail_attempts`, sleep about 100 ms and fail with no progress write.
      - If `n < 3`: `status='queued'`, `progress_completed=0`, `available_at=now+500`.
      - Else: `status='failed'`, `error='transient failure'`, `result_output=NULL`.
    - Otherwise, for each step: sleep 100 ms, then `UPDATE progress_completed=i, updated_at`.
    - After the last step: `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`.
    - Guard every update with `WHERE id=? AND status='running'`.
11. **Worker SIGTERM**:
    - Set `stopping`. The step loop checks `stopping` after each sleep and aborts.
    - Put an aborted job back: `status='queued'`, `attempts=attempts-1`, `progress=0`.
    - `clearInterval`, `db.close()`, `process.exit(0)` within about 1 s.
12. **UI**:
    - Form `data-testid="job-form"` with `novalidate`, containing:
      - `<textarea data-testid="job-input">`
      - `<input type="text" inputmode="numeric" data-testid="job-steps" value="5">`
      - `<input … data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
      - `<div data-testid="form-error" role="alert"></div>`
      - `<ul data-testid="job-list">`
    - **Submit**: `preventDefault`. Build the body as follows:
      - `input` is the raw value.
      - For each numeric field: if blank, omit the key; if it matches `/^-?\d+(\.\d+)?$/`, send `Number(v)`; otherwise send the raw string so the API rejects it.
    - **Response handling**: POST with a JSON content type. On a non-2xx response, fill `form-error` using `textContent` with the message plus one line per field: `"<field>: <message>"`. On success, clear `form-error` and the input, then refresh.
    - **Refresh**: on load and every 1000 ms, `fetch('/api/jobs')`. Render each job as `<li data-testid="job-item" data-job-id=id>` containing `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, else `''`).
    - Use `textContent` only, never innerHTML with user data. Preserve the API's newest-first order.

## Behaviours to verify
Run `npm run build`, then `npm run check:smoke` and `npm run check:contract` (the latter covers the contract cases). Also spot-check manually with `PORT=3100 DATABASE_PATH=/tmp/t/jobs.db`:
- **Create and list**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}'` → 201, queued, attempts 0, progress 0/2. `GET /api/jobs` shows it first.
- **Validation**: `{"input":"a","steps":"2"}`, `failAttempts:7`, `colour:"blue"`, missing input, `[]`, `not json`, no content-type, `Idempotency-Key: bad key!` → each gives 400 with the right `fields[].field`, and the job count is unchanged.
- **Idempotency**:
  - The same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` → 201 then 200, same id.
  - A different input → 409.
  - Restart the server and replay → still 200, same id.
- **Processing**: watch `GET /api/jobs/:id` while the job runs. Progress increments, then completed with `HI` and attempts 1.
- **Retries**: `failAttempts:1` → completed with attempts 2. `failAttempts:2` → attempts 3, completed. `failAttempts:3` → failed, `"transient failure"`, attempts 3, result null.
- **Health**: `worker` is `up` while the worker runs. Kill the worker and it shows `down` within about 3 s.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run and restart it. The job completes. Completed jobs are untouched (`attempts` unchanged).
- **Start order and shutdown**: start the worker before the server against a fresh dir (the parent dir gets created). `kill -TERM` on each exits promptly with code 0.
- **UI**: open `/`, submit `steps=abc` → `form-error` shows "steps". A valid submit shows the item, progress ticks and the result appears.
- **404/405**: `GET /nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `POST /health` → 405.

## Risks
- **Ordering**: sorting newest-first by `created_at` ties within the same ms. Use `seq`.
- **Type checks**: `typeof null === 'object'` and `Array.isArray` both need handling. `Number.isInteger(2.0)` is true, which is acceptable. Never coerce numeric strings.
- **Recovery**: plain re-queueing would push `attempts` to 4. Decrement on recovery and on SIGTERM abort.
- **SQLite locking**: two processes write concurrently. Keep busy_timeout and use `BEGIN IMMEDIATE` for claim and create. Always COMMIT or ROLLBACK in `finally` so the connection is never left inside a transaction.
- **Heartbeat**: it must keep beating during long jobs. Use a `setInterval`, not the loop, and keep it independent of the step `await`s.
- **Imports**: `.ts` extension imports are required. `rewriteRelativeImportExtensions` is on, so keep `./db.ts`. `node:sqlite` returns rows as null-prototype objects with numbers, so cast fields explicitly. The `node:sqlite` `ExperimentalWarning` is already suppressed by the npm scripts.
- **Content type**: every response, including 404/405/500, must carry `application/json`. Only `/` returns HTML.
- **UI**: `type="number"` inputs would swallow invalid text and block API validation. Use text inputs with `novalidate`.