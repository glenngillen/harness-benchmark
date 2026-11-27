# Plan

## Approach
The SQLite file is the only link between the two processes. `src/db.ts` creates the schema and holds the shared data-access helpers. `src/server.ts` is a `node:http` router that validates requests, handles idempotency inside a `BEGIN IMMEDIATE` transaction and serves the UI. `src/worker.ts` is a polling loop. It writes a heartbeat row every 1 s, claims the oldest due queued job, runs its steps and writes progress after each one, and schedules retries using a `run_after` timestamp. Jobs left `running` by a dead worker are put back in the queue at worker startup. `ui/index.html` is a single page with no framework: one form plus a list that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (it already does mkdir, busy_timeout and WAL). Add `CREATE TABLE IF NOT EXISTS` schema, the `JobRow` type, `rowToJob()`, and an `nowIso()` helper.
- `src/server.ts`: rewrite. Routing, body reading, validation, idempotency, error shape, health, UI serving, SIGTERM.
- `src/worker.ts`: rewrite. Heartbeat, recovery, claim, processing, retry, SIGTERM.
- `ui/index.html`: form, error region, job list and polling script, with every required `data-testid`.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas; idempotent and safe to run from both processes):
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
     resume INTEGER NOT NULL DEFAULT 0,
     run_after INTEGER NOT NULL DEFAULT 0,       -- epoch ms
     idempotency_key TEXT UNIQUE,
     payload TEXT,                               -- canonical JSON
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
   ```
   `rowToJob` maps a row to the exact JSON shape: `progress: {completed: progress_completed, total: steps}`, `result: status==='completed' ? {output: result_output} : null`, `error: status==='failed' ? error : null`. Use `crypto.randomUUID()` for ids and `new Date().toISOString()` for timestamps.
2. **Server helpers**: `send(res, status, body)` always sets `content-type: application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)` builds the error shape. Read the body as a utf8 string; reject anything over 1 MB with a `body` error.
3. **Routing** (after `new URL`, using the pathname):
   - `/health` accepts GET only.
   - `/` accepts GET only and returns the HTML.
   - `/api/jobs` accepts GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` accepts GET only. Run `decodeURIComponent` on the id inside a try block and return 404 if it throws.
   - A known path with another method gets 405 `method_not_allowed`. Everything else gets 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` as JSON.
4. **Validation for POST**. Collect every error into `fields[]`:
   - Content-Type: take the part before `;`, trim it and lowercase it. It must equal `application/json`. If not, add a `body` error and return 400 immediately.
   - If `Idempotency-Key` is present and fails `/^[A-Za-z0-9_-]{1,128}$/`, add an `Idempotency-Key` error.
   - If `JSON.parse` throws, add a `body` error. If the result is not a plain object (null, array or primitive), add a `body` error.
   - Each unknown key gets its own error with that key's name.
   - `input` must be a string with `1 <= length <= 1000` and `trim() !== ''`. Store it untouched.
   - `steps` and `failAttempts`: if the key is present (even as `null`), require `typeof === 'number' && Number.isInteger(v)` and the range check. Absent keys get the defaults 5 and 0.
   - If there are any errors, return 400 `invalid_request`.
5. **Create and idempotency**:
   - Canonical payload is `JSON.stringify({input, steps, failAttempts})` after defaults are applied, in a fixed key order.
   - Run `BEGIN IMMEDIATE`. If there is a key, `SELECT` by `idempotency_key`. If a row exists, compare `payload`: equal means `COMMIT` and return 200 with the existing job; different means `COMMIT` and return 409 `idempotency_conflict`.
   - Otherwise `INSERT` a row with status `queued`, `run_after = 0`, and `created_at = updated_at = now`. `COMMIT` and return 201.
   - `ROLLBACK` on any exception. The UNIQUE constraint on the key is a backstop.
6. **GET list**: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs: [...]}`. Do not order by timestamp, because ties are possible. **GET one**: return the job or 404 `not_found`.
7. **Health**: read `last_seen` and return `worker: 'up'` if `Date.now() - last_seen < 3000`, otherwise `'down'`. A missing row counts as down.
8. **Server SIGTERM/SIGINT**: `server.close()`, then `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Log once the server is listening.
9. **Worker startup**:
   - Write the heartbeat immediately as an upsert (`INSERT ... ON CONFLICT(id) DO UPDATE`). Repeat it with `setInterval` every 1000 ms.
   - Recovery: `UPDATE jobs SET status='queued', resume=1, progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run with the same attempt number, so `attempts` never goes past 3. This is safe because only one worker runs at a time.
10. **Worker loop** (runs `while (!stopping)`):
    - Claim inside `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`. Then `UPDATE` it to `status='running'`, set `attempts = attempts + (resume ? 0 : 1)`, `resume=0`, `progress_completed=0`, and `updated_at`. `COMMIT`.
    - If nothing is due, sleep 200 ms.
    - Run the attempt. Let `n` be the new attempt count.
      - If `n <= fail_attempts`: sleep about 100 ms, then fail. If `n < 3`, set `status='queued'`, `run_after=Date.now()+500`, `progress_completed=0`. Otherwise set `status='failed'`, `error='transient failure'`, `result_output=NULL`.
      - Otherwise, for each step from 1 to `steps`: sleep 100 ms, then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps.
      - Finally set `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`.
    - Every update after the claim must include `AND status='running'` in its WHERE clause.
11. **Worker SIGTERM**: set `stopping`. If a job is mid-run, the loop stops at the next step boundary and sets that job back to `queued` with `resume=1` and `progress_completed=0`. Then clear the heartbeat interval, set `last_seen=0`, run `db.close()`, and `process.exit(0)`. Also add a 3 s fallback `setTimeout(() => process.exit(0)).unref()`.
12. **UI** (`ui/index.html`):
    - Form: `<form data-testid="job-form" novalidate>`. The `novalidate` is required so out-of-range values reach the API.
    - Fields:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - Error region: `<div data-testid="form-error" role="alert"></div>`.
    - List: `<ul data-testid="job-list">`.
    - On submit, call `preventDefault`. Build the body with `input` as the raw string. For each numeric field, omit it if the raw value is empty. Otherwise send `Number(raw)` if it is finite, or the raw string if not, so the API rejects it.
    - POST with `Content-Type: application/json`.
    - If the response is not ok, set `form-error`'s `textContent` to the message followed by each `field: message` line. If it is ok, clear `form-error` and refresh the list right away.
    - Poll `GET /api/jobs` with `setInterval(refresh, 1000)`, plus once on load.
    - Render with `textContent` only, never innerHTML with job data. Each `<li data-testid="job-item" data-job-id=id>` contains spans for `job-status` (status), `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`), plus the input text.

## Behaviours to verify
- Build and start: `npm run build && (PORT=3100 DATABASE_PATH=/tmp/jt/a.db npm run start:server &) ; DATABASE_PATH=/tmp/jt/a.db npm run start:worker &`. The `/tmp/jt` directory should be created automatically.
- Health: `curl localhost:3100/health` returns `up`. Stop the worker, and within about 3 s it returns `down`.
- Create and complete: POST `{"input":"hi","steps":3}` returns 201, with status queued, attempts 0 and progress 0/3. Polling `GET /api/jobs/:id` shows progress rising, then `completed` with `result.output "HI"`.
- Retries: `failAttempts:2` completes with attempts 3. `failAttempts:3` ends `failed` with attempts 3, error `"transient failure"` and result null. Each case leaves exactly one job in the list.
- Validation: each of these returns 400 `invalid_request`, and the job count is unchanged afterwards:
  - `steps:"2"`
  - `failAttempts:7`
  - `steps:1.5`
  - `colour`
  - missing `input`
  - `"   "`
  - 1001 characters
  - `[]`
  - `null`
  - malformed JSON
  - no Content-Type, or `text/plain`
  - Idempotency-Key `"bad key!"`
- Idempotency: `{"input":"a"}` with key K returns 201. Then `{"input":"a","steps":5,"failAttempts":0}` with K returns 200 with the same id. `{"input":"b"}` with K returns 409. Restart the server and replay: still 200 with the same id.
- Routes: `/nope` returns 404 `not_found`. `DELETE /api/jobs` returns 405. `GET /api/jobs/xyz` returns 404. Every response is JSON.
- Crash recovery: submit `steps:20` and `kill -9` the worker mid-run. Restart it. The job reruns and completes, with attempts unchanged (it is the same attempt). Completed jobs are not touched.
- SIGTERM: `kill -TERM` each process and confirm it exits quickly with code 0.
- UI: open `/`, submit a job, and watch the status and progress update without a reload. Submit `steps` 50 and check that `form-error` shows `steps`.
- Run `npm run check:smoke` and `npm run check:contract` after building.

## Risks
- **Content-Type on errors**: every path, including 404, 405, 500 and oversize bodies, must send JSON with `application/json`. Funnel all of them through `send`.
- **Browser validation**: if `min`/`max` are set without `novalidate`, the browser blocks out-of-range submissions and the API error never appears. Keep `novalidate`.
- **Numeric strings**: never coerce `"3"` to a number on the server. Check `typeof`.
- **SQLITE_BUSY**: both processes write. Keep busy_timeout, use `BEGIN IMMEDIATE` for claim and create, and keep transactions short (never sleep inside one).
- **Retry delay**: it must be between 250 ms and 2 s. Use `run_after` so a waiting retry doesn't block other jobs, and keep the poll interval at 200 ms or less so idle pickup happens within 1 s.
- **Crash recovery and attempts**: incrementing `attempts` for the recovered run could produce attempt 4. Use the `resume` flag.
- **Imports**: keep the `.ts` extensions in relative imports (tsconfig rewrites them). Keep reading the UI via `new URL('../ui/index.html', import.meta.url)`, which resolves from `dist/`.
- **Typing**: `node:sqlite` returns rows typed as `unknown`. Cast to `JobRow`. Pass only numbers, strings or null as parameters, never undefined or booleans.
- **Shutdown hangs**: a pending interval or keep-alive socket can stop the process exiting. Call `closeAllConnections`, clear intervals, and then call `process.exit(0)` explicitly.