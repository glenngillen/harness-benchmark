# Plan

## Approach
Keep the existing layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` is a `node:http` API that also serves `ui/index.html`, and `src/worker.ts` polls SQLite for jobs. All state lives in one `jobs` table plus a one-row `heartbeat` table. The worker claims a job with a conditional `UPDATE`, writes progress after every step, and requeues failed attempts by setting a `run_after` timestamp. Idempotency uses a UNIQUE column with a stored canonical payload, checked inside a `BEGIN IMMEDIATE` transaction. The UI is one static HTML file with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). After the pragmas, create the schema with `CREATE TABLE IF NOT EXISTS`. Export a `rowToJob(row)` mapper and a `nowIso()` helper.
- `src/server.ts`: rewrite with routing, validation, idempotency, health, JSON errors, serving the UI, and SIGTERM shutdown.
- `src/worker.ts`: rewrite with heartbeat, recovery on startup, the poll/claim/step loop, retries, and SIGTERM shutdown.
- `ui/index.html`: form, error region and job list with every required `data-testid`, plus inline polling JS.

## Steps
1. **Schema** (in `openDatabase`, run on every open; both processes may run it at once, and busy_timeout covers that):
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
     run_after INTEGER NOT NULL DEFAULT 0,      -- epoch ms
     idempotency_key TEXT UNIQUE,
     payload TEXT);                              -- canonical JSON
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_ms INTEGER NOT NULL);
   ```
   `rowToJob` returns exactly the documented shape:
   - `progress` is `{completed: progress_completed, total: steps}`.
   - `result` is `{output}` only when status is `completed`, otherwise `null`.
   - `error` is the stored text only when status is `failed`, otherwise `null`.
2. **Server helpers**:
   - `send(res, status, body)` sets `content-type: application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body as a utf8 string, capped at about 1 MB. Over the cap is a 400 with field `body`.
3. **Routing** (`pathname` from `new URL`):
   - `/`: GET serves the HTML.
   - `/health`: GET only.
   - `/api/jobs`: GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/`: GET only. Run `decodeURIComponent` inside a try; failure means 404.
   - Known path with another method: 405 `method_not_allowed`. Anything else: 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` as JSON.
4. **Health**: `SELECT beat_ms FROM heartbeat WHERE id=1`. Return `worker: "up"` if `Date.now() - beat_ms < 3000`, otherwise `"down"`.
5. **POST validation**. Collect `fields[]` and then return a 400 `invalid_request` with message "Invalid request":
   - Content-Type: missing, or media type (before `;`, lowercased and trimmed) not `application/json` → field `body`. Return early.
   - Body: `JSON.parse` fails → `body`. Not a plain object (null, array or primitive) → `body`. Return early.
   - Unknown keys → one entry per key, using the key as the field name.
   - `input`: must be a string with `1 <= length <= 1000` and `trim() !== ''`. Store it unchanged.
   - `steps` / `failAttempts`: if present (`!== undefined`), must satisfy `typeof === 'number' && Number.isInteger && in range`. Otherwise apply the default.
   - `Idempotency-Key` header: if present (including empty), it must match `^[A-Za-z0-9_-]{1,128}$`; otherwise add field `Idempotency-Key`. Put this in the same `fields` list as the body errors.
6. **Create**:
   - Build the canonical payload: `JSON.stringify({input, steps, failAttempts})` with the keys always in this order.
   - Run `BEGIN IMMEDIATE`. If there is a key, `SELECT` by `idempotency_key`:
     - Found with equal payload → COMMIT and return 200 with that job.
     - Found with a different payload → COMMIT and return 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = crypto.randomUUID()`, status `queued`, and `created_at = updated_at = new Date().toISOString()`, then COMMIT and return 201.
   - ROLLBACK on any exception.
7. **List and get**:
   - List: `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs}`. Sort by `seq`, not the timestamp, because timestamps can tie.
   - Get: look up by id, or return 404 `not_found`.
8. **Server SIGTERM/SIGINT**: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Log once listening.
9. **Worker startup**:
   - Open the DB and write the heartbeat right away with `INSERT ... ON CONFLICT(id) DO UPDATE SET beat_ms=excluded.beat_ms`.
   - Repeat the heartbeat with `setInterval` every 1000 ms.
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run under the same attempt number, which keeps attempts ≤ 3 and the failAttempts semantics consistent.
   - This is safe because only one worker runs. Add a code comment saying so.
10. **Worker loop** (`while (!stopping)`):
    - Select `SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq ASC LIMIT 1`. If there is none, sleep 200 ms and loop.
    - Claim with `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`. Skip if `changes===0`, then re-read the row.
    - Let `n = attempts`. If `n <= fail_attempts`: sleep 100 ms, then:
      - if `n < 3`: `status='queued', run_after=Date.now()+500`;
      - else: `status='failed', error='transient failure', result_output=NULL`;
      - and continue the loop.
    - Otherwise, for `i = 1..steps`: sleep 100 ms (if `stopping`, break out and leave the job `running` so recovery picks it up), then `UPDATE progress_completed=i, updated_at`.
    - Finally `UPDATE status='completed', result_output=input.toUpperCase(), error=NULL, updated_at`.
11. **Worker SIGTERM/SIGINT**: set `stopping`. After the loop exits, run `clearInterval`, `db.close()`, `process.exit(0)`. Exit within about 200 ms; don't wait for the job to finish.
12. **UI** (`ui/index.html`):
    - Form `data-testid="job-form"` with the `novalidate` attribute. Fields:
      - `<input type="text" data-testid="job-input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - Error region: `<div data-testid="form-error" role="alert"></div>`.
    - List: `<ul data-testid="job-list">`.
    - On submit: `preventDefault`. Build the body as `{input: value}`. For each numeric field, omit it if blank, otherwise send `Number(value)`. NaN serializes to null, which the API rejects, which is the desired behaviour.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, set `form-error` text to `error.message` followed by each `field: message`.
    - On success, clear the error and the input, then refresh.
    - Refresh: `fetch('/api/jobs')` every 1000 ms and on load. Render each job as an `<li data-testid="job-item" data-job-id=id>` containing spans `job-status`, `job-progress` (`${completed}/${total}`), and `job-result` (result.output, else error, else empty). Use `textContent` only.
    - Keep the server's order (newest first). Rebuilding the list each poll is fine.
13. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`. Check `checks/cli.ts` to see how they launch the processes.

## Behaviours to verify
- **Build and startup**: `npm run build`. Start the server and worker in either order with `DATABASE_PATH=/tmp/x/j.db` (a directory that doesn't exist yet). Both should log within 10 s.
- **Health**: `curl /health` shows `up` with the worker running and `down` about 3 s after you kill it.
- **Create and get**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}' /api/jobs` returns 201 queued with attempts 0 and progress 0/2. GET by id shows it completed with output `HI`.
- **Progress is observable**: with `steps: 20`, poll every 100 ms and watch `progress.completed` increase.
- **Validation**: each of these returns 400 with the expected field:
  - `steps:"2"` → `steps`
  - `failAttempts:7` → `failAttempts`
  - `colour` → `colour`
  - missing input → `input`
  - `"   "` input → `input`
  - `[]` body → `body`
  - bad JSON → `body`
  - text/plain → `body`
  - key `"a b"` → `Idempotency-Key`

  The job count must not change.
- **Idempotency**: `{"input":"a"}` with key K returns 201. `{"input":"a","steps":5,"failAttempts":0}` with K returns 200 with the same id. A different input with K returns 409. After a server restart, the replay still returns 200.
- **Retries**:
  - `failAttempts:1` → completed, attempts 2.
  - `failAttempts:2` → completed, attempts 3.
  - `failAttempts:3` → failed, `error:"transient failure"`, attempts 3, result null.
  - Only one job is listed for each.
- **Crash recovery**: submit `steps:20` and `kill -9` the worker mid-run. Restart it; the job completes. Also kill both processes and restart; all jobs are still present.
- **Routes**: unknown path → 404 JSON. `DELETE /api/jobs` → 405. `PUT /health` → 405.
- **UI**: open `/`. Submit with steps 50 and `form-error` shows "steps". A valid submission appears at the top and moves through queued → running x/y → completed without a reload.
- **Shutdown**: `kill -TERM` makes each process exit promptly with code 0.

## Risks
- **Timestamp ordering**: equal `createdAt` values break "newest first". Order by `seq`.
- **Numeric strings**: `Number.isInteger("3")` is false, but don't coerce anywhere. Check `typeof === 'number'`.
- **Content-Type with parameters**: `application/json; charset=utf-8` must be accepted, so parse the media type.
- **Idempotency races and restarts**: use the UNIQUE column plus `BEGIN IMMEDIATE`, never in-memory maps.
- **Recovery overshooting 3 attempts**: decrement attempts when requeuing a crashed `running` job, then let the normal claim increment it.
- **Heartbeat stalls**: node:sqlite is synchronous, but sleeps are async, so `setInterval` still fires during a job. Never busy-wait.
- **Default values**: `result` and `error` must be `null`, not `undefined` or missing.
- **Browser validation**: with min/max on number inputs and no `novalidate`, the browser blocks invalid submissions, so `form-error` never shows the API rejection. Keep `novalidate`.
- **UI path**: the server reads `../ui/index.html` relative to `dist/server.js`. Keep that relative path, and keep the `.ts` import extensions (`rewriteRelativeImportExtensions` is on).
- **Shutdown with open connections**: SIGTERM must call `process.exit`, or open keep-alive connections and intervals will keep the process alive.
- **Error status codes**: every error, including 404 and 405, must return JSON with the application/json content type, never the old 501.