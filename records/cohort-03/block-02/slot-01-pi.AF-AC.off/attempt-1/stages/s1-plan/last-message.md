# Plan

## Approach
Keep the current layout: `src/db.ts` holds the shared schema and data access, `src/server.ts` is the `node:http` API plus static UI, `src/worker.ts` is the polling worker, and `ui/index.html` is a single page with inline JS. All state lives in SQLite via `node:sqlite` `DatabaseSync`, which is already in WAL mode with a busy timeout. There is one `jobs` table and one `heartbeat` table. The worker claims jobs atomically, writes progress after every step, sets retry times with a `run_after` column, and on startup puts any `running` jobs back in the queue. Idempotency uses a UNIQUE `idempotency_key` column plus the stored canonical payload, checked inside a `BEGIN IMMEDIATE` transaction so it holds across restarts and concurrent requests.

## Files
- `src/db.ts`: keep `openDatabase`. Add the schema (`CREATE TABLE IF NOT EXISTS`), a `JobRow` type, `rowToJob()` serializer and shared helpers (`nowIso()`, a `transaction(db, fn)` wrapper using `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`).
- `src/server.ts`: routing, body reading, validation, idempotency, health, serving the UI, SIGTERM shutdown.
- `src/worker.ts`: heartbeat, recovery, claim loop, step processing, retries, SIGTERM shutdown.
- `ui/index.html`: form, error region, polling job list with all required `data-testid`s.

## Steps
1. **Schema** (in `openDatabase`, run after the pragmas; both processes run it, and that is safe with IF NOT EXISTS and the busy timeout):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), ts INTEGER NOT NULL);
   ```
   `rowToJob` returns exactly these fields: `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Sort newest first by `seq DESC`, not by timestamp, because jobs created in the same millisecond have equal timestamps.
2. **Server helpers**: `send(res, status, body)` always sets `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)` builds the error shape. Read the body as a Buffer, capped at about 1 MB (return 400 for `body` if larger).
3. **Routing** (`new URL(req.url, 'http://x').pathname`):
   - `/`: GET serves the HTML, other methods get 405.
   - `/health`: GET only.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/<id>`: GET only, matched with `^/api/jobs/([^/]+)$`, then `decodeURIComponent` inside a try block (decode failure returns 404).
   - Any other method on these paths returns 405 `method_not_allowed`. Every other path returns 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` on unexpected errors.
4. **POST validation**: build a `fields` array and collect every problem before responding.
   - Content-Type: take the media type before `;`, trim and lowercase it. It must be `application/json`. If it is missing or different, add `{field:'body'}`.
   - `Idempotency-Key`: if the header is present, including an empty string, it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add `{field:'Idempotency-Key'}`.
   - Body: if the Content-Type is OK, run `JSON.parse`. A parse error or empty body adds `body` "malformed JSON". A value that is not a plain object (null, array, primitive) adds `body`.
   - Fields of an object body:
     - Every key other than `input`, `steps`, `failAttempts` adds that key's name.
     - `input` must be a string with `length` from 1 to 1000 and `trim() !== ''`. Store it unmodified.
     - `steps` and `failAttempts`: if `undefined`, use the default. Otherwise require `typeof === 'number' && Number.isInteger(v)` within range. `null` and `"3"` are rejected.
   - If `fields` is non-empty, return 400 `invalid_request`.
5. **Create plus idempotency**:
   - The canonical payload is `JSON.stringify({input, steps, failAttempts})` after defaults are applied, always in that key order.
   - Inside `transaction()`: if a key was given, run `SELECT * FROM jobs WHERE idempotency_key=?`. If a row is found, return 200 with that job when its `payload` matches, and 409 `idempotency_conflict` when it does not.
   - Otherwise insert with `id = randomUUID()`, status `queued`, both timestamps set to the same `new Date().toISOString()`, and `run_after = 0`. Return 201.
   - Also catch a UNIQUE constraint error: re-select the row and apply the same comparison.
6. **Health**: run `SELECT ts FROM heartbeat WHERE id=1`. Return `worker: 'up'` if the row exists and `Date.now() - ts < 3000`.
7. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add an unref'd 2 s fallback `process.exit(0)`. Keep the UI path as `new URL('../ui/index.html', import.meta.url)`, which works from `dist/`.
8. **Worker startup**:
   - Open the DB and write the heartbeat right away: `INSERT ... ON CONFLICT(id) DO UPDATE SET ts=excluded.ts`. Then run `setInterval(heartbeat, 500)`.
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. This re-runs the interrupted attempt with the same attempt number, so `attempts` never exceeds 3 and failure semantics stay consistent.
9. **Worker loop**: `while (!stopping)`:
   - **Claim** inside `transaction()`: select the first job with `status='queued' AND run_after<=now`, ordered by `seq ASC`, with `LIMIT 1`. Then `UPDATE ... SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`.
   - If nothing was claimed, `await sleep(200)` and continue.
   - **Process**: let `n` be the new `attempts`.
     - If `n <= fail_attempts`, the attempt fails at its first step: `await sleep(100)`, then fail without progress (see the retry bullet).
     - Otherwise, for each step: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps.
     - After the last step: `status='completed', result_output=input.toUpperCase(), progress_completed=steps, error=NULL`.
   - **Retry**: if `n < 3`, set `status='queued', progress_completed=0, run_after=Date.now()+500`. Otherwise set `status='failed', error='transient failure', result_output=NULL`.
   - **Stop mid-job**: put the job back as in recovery (queued, `attempts-1`).
10. **Worker shutdown**: SIGTERM sets `stopping`. After the loop exits, clear the interval, set the heartbeat `ts=0` and close the DB. Add a 3 s unref'd fallback exit.
11. **UI (`ui/index.html`)**:
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - `<div data-testid="form-error" role="alert"></div>`, empty by default.
    - `<ul data-testid="job-list">`.
    - **On submit** (`preventDefault`): build the body. The input string is sent as is. For each numeric field: omit it if empty; else send `Number(v)` if it is finite; else send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, fill `form-error` with `error.message` plus one line per field as `` `${f.field}: ${f.message}` ``.
    - On success, clear `form-error` and refresh right away.
    - Poll `GET /api/jobs` every 1000 ms. Render one `<li data-testid="job-item" data-job-id=id>` per job, in API order, with child spans `job-status`, `job-progress` (`completed/total`) and `job-result` (output if completed, error if failed, else `''`).
    - Use `textContent` only, never innerHTML with job data.

## Behaviours to verify
- **Build and start**: `npm run build && PORT=3100 DATABASE_PATH=/tmp/jt/a.db npm run start:server` plus `start:worker` in another terminal, in either order. The `/tmp/jt` directory gets created.
- **Health**: `curl :3100/health` shows `up` with the worker running, and `down` within 3 s after stopping it.
- **Create**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}'` returns 201 queued with `attempts` 0 and progress `0/3`.
- **Progress and completion**: polling GET shows progress increasing, then `completed` with `"HI"`.
- **Validation**: these each return 400 with the named field:
  - `steps:"2"` → `steps`
  - `failAttempts:7` → `failAttempts`
  - `colour:"blue"` → `colour`
  - missing input → `input`
  - `"   "` input → `input`
  - `[]` body → `body`
  - bad JSON → `body`
  - `text/plain` → `body`
  - key `"a b"` → `Idempotency-Key`

  The job count does not change.
- **Idempotency**: the same key and payload (with and without explicit defaults) returns 200 with the same id. A different payload returns 409. Restart the server and replay: still 200 with the same id.
- **Retries**: `failAttempts:1` gives completed with attempts 2. `failAttempts:2` gives completed with attempts 3. `failAttempts:3` gives failed, `"transient failure"`, attempts 3. Exactly one job in the list.
- **Routing**: `/nope` returns 404, `DELETE /api/jobs` returns 405, `GET /api/jobs/xyz` returns 404 `not_found`.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it, and the job completes. `kill -9` both processes, restart, and all jobs are still listed. Completed jobs keep their attempts unchanged.
- **SIGTERM**: `kill -TERM` exits each process promptly with code 0.
- **UI**: open `/`, submit, and watch status and progress update. Submit `steps` 50 and `form-error` shows "steps".
- **Bundled checks**: run `npm run check:smoke` and `npm run check:contract`. Read `checks/cli.ts` for the env vars and arguments they expect.

## Risks
- **Content type**: responses must use `application/json` on every path, including 404, 405 and 500. Use the single `send` helper everywhere.
- **Validation leaks**: do not let `steps: null` or `steps: 3.5` fall through to defaults. Only `undefined` gets the default.
- **Idempotency races**: do the check-then-insert in one `BEGIN IMMEDIATE` transaction. Always ROLLBACK on throw, or the connection stays locked.
- **Heartbeat stalls**: never block the worker event loop. Use `await sleep` between steps so the heartbeat interval keeps firing. Keep the heartbeat at 500 ms, well under 3 s.
- **SIGTERM hangs**: the worker loop must react within one step or poll interval. The server's keep-alive connections can block `close()`, so call `closeAllConnections()`.
- **Imports**: keep the `./db.ts` imports. `rewriteRelativeImportExtensions` turns them into `.js`. Don't use TS features that fail with `verbatimModuleSyntax` (use `import type` for types).
- **Ordering**: sort by `seq`, not `created_at`, for both newest-first lists and oldest-first claiming.
- **Browser validation**: the form needs `novalidate`, or the browser blocks out-of-range numbers before the API sees them. The evaluator expects API errors in `form-error`.
- **`progress.completed`**: it must be reset to 0 when the job goes back to `queued` and at each new attempt, and set to `steps` on completion.