# Plan

## Approach
Use one SQLite schema module (`src/db.ts`) that both processes share. The server is a plain `node:http` router that validates input, handles idempotency through a UNIQUE column, and maps rows to the job JSON shape. The worker runs one async loop: it claims the oldest due `queued` job, runs its steps with sleeps, writes progress after each step, and schedules retries through a `run_after` timestamp column. A separate interval writes a heartbeat row, which `/health` reads. The UI is one static HTML file with inline JS. It polls `GET /api/jobs` every second and posts the form as JSON.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add the schema creation (`CREATE TABLE IF NOT EXISTS`, run on every open by both processes), the `JobRow` type, `rowToJob()`, and `nowIso()`.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotency, error helpers, `/health` and SIGTERM handling.
- `src/worker.ts`: rewrite with recovery on startup, heartbeat, claim/process loop, retry scheduling and graceful shutdown.
- `ui/index.html`: the form, the error region and the job list with all required `data-testid`s, plus inline JS.

## Steps
1. **Schema** (in `db.ts`, run after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, run_after INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
   ```
   `rowToJob` returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Use `crypto.randomUUID()` for ids and `new Date().toISOString()` for timestamps. Sort by `seq DESC` for "newest first", not by `created_at`, because timestamps tie within the same millisecond.
2. **Server helpers**:
   - `send(res, status, body)` always sets `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Wrap the handler in try/catch and return 500 `internal_error` on failure.
3. **Routing**. Strip the query string from the pathname, then:
   - `/` accepts GET (HTML) only.
   - `/health` accepts GET only.
   - `/api/jobs` accepts GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` accepts GET only. Wrap `decodeURIComponent` in try/catch; a bad encoding returns 404.
   - A known path with the wrong method returns 405 `method_not_allowed` with an `Allow` header.
   - Anything else returns 404 `not_found`.
   - An unknown job id returns 404 `not_found`.
4. **POST validation**. Collect every problem into `fields[]`, then return 400 `invalid_request` if there are any:
   - **Content-Type**: take the media type from `req.headers['content-type']` (split on `;`, trim, lowercase). It must equal `application/json`. If it is missing or wrong, add **both** `{field:"Content-Type"}` and `{field:"body"}`, then return the 400 straight away without parsing.
   - **Body size**: read the body up to about 1 MB. If larger, return the 400 with field `body`.
   - **JSON**: wrap `JSON.parse` in try/catch. Malformed JSON gives field `body`. So does a parsed value that is not a plain object (null, an array or a primitive).
   - **Unknown keys**: each key from `Object.keys(body)` not in {input, steps, failAttempts} gets its own field entry. This also catches `__proto__`. Read values with `Object.hasOwn`.
   - **`input`**: must be present, `typeof === 'string'`, length 1–1000, and `input.trim().length > 0`. Store it unmodified.
   - **`steps` / `failAttempts`**: if present, must be `typeof === 'number'` and `Number.isInteger`, within 1–20 and 0–5. If absent, use defaults 5 and 0. `null` counts as present and is wrong.
   - **`Idempotency-Key`**: if the header is present (including empty), it must match `/^[A-Za-z0-9_-]{1,128}$/`, otherwise field `"Idempotency-Key"`. Validate the header alongside the body so all errors are reported together.
5. **Create plus idempotency.** Run this in `BEGIN IMMEDIATE` … `COMMIT` (ROLLBACK on error).
   - If there is a key, `SELECT` by `idempotency_key` first.
     - If a row exists and `input`, `steps` and `fail_attempts` all match the defaulted payload, return 200 with that job.
     - If it exists and anything differs, return 409 `idempotency_conflict`.
   - Otherwise INSERT with status `queued`, attempts 0, progress 0, `run_after = 0`, and `created_at = updated_at = now`. Return 201.
   - The UNIQUE constraint makes "never more than one job per key" hold across restarts.
6. **`/health`**: `SELECT last_seen FROM heartbeat WHERE id=1`. Report `worker:'up'` if `Date.now() - last_seen < 3000`, else `'down'`.
7. **Server shutdown**: on SIGTERM/SIGINT:
   - `server.close()` and `server.closeAllConnections()`.
   - `db.close()` and `process.exit(0)`.
   - Add a 2 s `setTimeout(...).unref()` fallback that exits.
   Keep reading `ui/index.html` via `new URL('../ui/index.html', import.meta.url)`, and keep the `./db.ts` import style (the tsconfig rewrites the extension).
8. **Worker startup**:
   - Open the DB.
   - **Recovery**: run `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run under the same attempt number, which keeps `attempts ≤ 3` and keeps fail semantics deterministic.
   - Write the heartbeat right away (`INSERT … ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`), then every 1000 ms with `setInterval`.
9. **Worker loop** (while not stopping):
   - Select `SELECT * FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY seq ASC LIMIT 1`.
   - If none, sleep 200 ms.
   - Otherwise claim it: `UPDATE … SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`. If `changes === 0`, skip. Re-read `attempts` as `n`.
   - **Failing attempt** (`n <= fail_attempts`): sleep about 100 ms, then:
     - If `n >= 3`, set `status='failed', error='transient failure', result_output=NULL, progress_completed=0`.
     - Otherwise set `status='queued', run_after=Date.now()+500, progress_completed=0`.
   - **Normal attempt**: for i = 1..steps, sleep 100 ms; if stopping, break out. Otherwise `UPDATE progress_completed=i, updated_at`. After the last step, set `status='completed', result_output=input.toUpperCase(), progress_completed=steps, error=NULL`.
10. **Worker shutdown**: SIGTERM/SIGINT sets `stopping`. The step loop checks it after each sleep.
    - If a job is mid-attempt, apply the same requeue as recovery to it (`attempts-1`, queued, progress 0).
    - Clear the heartbeat interval and set `last_seen=0` so health reports down at once.
    - Close the DB and exit 0. Total exit time stays well under 1 s.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" type="text">`, with **no** `required` or `maxlength`.
      - `<input data-testid="job-steps" type="number" value="5">` and `<input data-testid="job-fail-attempts" type="number" value="0">`, with **no** min, max or step attributes, so invalid values reach the API.
      - `<button data-testid="job-submit" type="submit">`.
    - `<div data-testid="form-error" role="alert"></div>`.
    - `<ul data-testid="job-list">`.
    - **On submit** (`preventDefault`):
      - Body `{input: value}`.
      - For each numeric field: if `value.trim() === ''`, omit it. Otherwise send `Number(v)` if it is finite, or the raw string if not (the API then rejects it).
      - POST with `Content-Type: application/json`.
      - On a non-2xx response, set `form-error.textContent` to `error.message` plus one line per field, `"<field>: <message>"`.
      - On success, clear the error and the input, then refresh immediately.
    - **Polling**: `setInterval(refresh, 1000)`. `refresh` GETs `/api/jobs` and reconciles the list keyed by id. Each job is an `<li data-testid="job-item" data-job-id>` containing spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, else ''). Keep list order equal to the API order (newest first). Use `textContent` only, never innerHTML with job data.

## Behaviours to verify
- **Build and start**: `npm run build && DATABASE_PATH=/tmp/t/jobs.db PORT=3100 npm run start:server` and `start:worker` in either order. The parent directory gets created.
- **Contract checks**: `npm run check:smoke` and `npm run check:contract` pass.
- **Validation**: curl cases should return 400 with the listed field:
  - `steps:"3"`, `steps:2.5`, `steps:0`, `steps:21`, `failAttempts:6`, unknown key, `input:"   "`, 1001 chars, missing input → the matching field.
  - `[]`, `null`, `{bad` → `body`.
  - No Content-Type and `text/plain` → `body` and `Content-Type`.
  - `Idempotency-Key: a b` → `Idempotency-Key`.
  - `GET /api/jobs` count is unchanged afterwards.
- **Idempotency**: `{"input":"a"}` then `{"input":"a","steps":5,"failAttempts":0}` with the same key → 201 then 200 with the same id. A different input → 409. Restart the server and replay → 200 with the same id.
- **Progress**: with `steps:10`, poll `GET /api/jobs/:id` every 100 ms and see `progress.completed` increase while `running`.
- **Retries**: `failAttempts:2` → completed with attempts 3. `failAttempts:3` → failed, `error:"transient failure"`, attempts 3, result null. Only one job per submission.
- **Health**: `/health` shows `up` with the worker running. It shows `down` within 3 s of `kill -9` on the worker, and right away after SIGTERM.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job completes. Completed jobs are untouched (their attempts don't change).
- **SIGTERM**: both processes exit quickly with code 0.
- **Routing**: `DELETE /api/jobs` → 405; `/nope` → 404 `not_found`; `GET /api/jobs/xyz` → 404.
- **UI**: open `/`, submit with steps 25 and see the alert mention `steps`. Submit a valid job and watch status and progress update with no reload.

## Risks
- **Browser constraint validation blocks submission** (because of `required`/`min`/`max`), so the API error never shows. Use `novalidate` and no constraint attributes.
- **Newest-first ordering by `created_at`** breaks on same-millisecond ties. Order by `seq`.
- **Numeric strings or `null` accepted**. Use strict `typeof === 'number'` plus `Number.isInteger`, and treat a present `null` as invalid rather than defaulted.
- **Content-Type with `; charset=utf-8` rejected**. Parse only the media type.
- **Recovered jobs exceeding 3 attempts or wrongly failing**. Decrement attempts on recovery and on graceful-shutdown requeue.
- **Worker starving retries or picking them up too early**. Always filter on `run_after <= now` and order by `seq`. Keep the idle poll at 200 ms so new jobs start within 1 s.
- **`SQLITE_BUSY` between processes**. Keep `busy_timeout` set before WAL, keep transactions short, and never hold a transaction across an `await`.
- **The server hangs on SIGTERM** because of keep-alive connections. Call `closeAllConnections` and keep the unref'd fallback exit.
- **Don't touch** `package.json`, `tsconfig.json` or `checks/`. Keep the `.ts` relative import extensions (the `rewriteRelativeImportExtensions` setting depends on them).