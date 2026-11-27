# Plan

## Approach
Put the SQLite schema and the shared job helpers in `src/db.ts`. The server (`src/server.ts`) and the worker (`src/worker.ts`) both open the same database file and create the schema at startup with `CREATE TABLE IF NOT EXISTS`, so either can start first. The server is a plain `node:http` router that validates requests and enforces idempotency with a UNIQUE column. The worker is a single loop: it polls for jobs, claims one inside a `BEGIN IMMEDIATE` transaction, runs the steps with `await sleep(100)`, writes progress after each step, and writes a heartbeat row every 500 ms. The UI is one static `ui/index.html` with vanilla JS that polls `GET /api/jobs` every second. A job's status, attempts, progress, retry time and result are all stored in the database, so a crash or restart recovery only needs a few SQL statements.

## Files
- `src/db.ts`: keep `openDatabase` (it already does mkdir, busy_timeout and WAL). Add schema creation, the `JobRow` type, `rowToJob(row)` to produce the API JSON shape, `nowIso()`, and heartbeat helpers.
- `src/server.ts`: rewrite: router, body reading, validation, idempotency, error helpers, `GET /` serving `ui/index.html`, SIGTERM handling.
- `src/worker.ts`: rewrite: recovery at startup, heartbeat, claim/process loop, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling script.

## Steps
1. **Schema** (in `db.ts`, exported as `initSchema(db)` and called by both processes right after `openDatabase`):
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
     idempotency_key TEXT UNIQUE,
     payload TEXT NOT NULL,
     next_run_at INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS worker_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), last_seen INTEGER NOT NULL);
   ```
   `next_run_at` is epoch ms. `payload` is the canonical JSON `JSON.stringify({input, steps, failAttempts})`, always with keys in that order and defaults applied.
2. **`rowToJob`** returns:
   `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`
   Timestamps come from `new Date().toISOString()`.
3. **Server helpers**:
   - `send(res, status, body)` with `content-type: application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **Routing** (use `pathname` from `new URL(req.url, 'http://x')`):
   - `/`: GET serves the HTML. Any other method gets 405.
   - `/health`: GET. Any other method gets 405.
   - `/api/jobs`: GET lists jobs, POST creates one. Any other method gets 405.
   - `/^\/api\/jobs\/([^/]+)$/`: GET returns the job. Any other method gets 405.
   - Anything else gets 404 `not_found`.
   - Look up ids with a prepared statement. Wrap `decodeURIComponent` in try/catch and return 404 if it throws.
5. **Health**: read `last_seen` from `worker_heartbeat`. `worker` is `"up"` if `Date.now() - last_seen < 3000`, otherwise `"down"`.
6. **List**: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs: rows.map(rowToJob)}`.
7. **POST validation**, in order:
   - **Content-Type:** take `content-type` split on `;`, trimmed and lowercased. It must be `application/json` (accepting `*/*+json` is fine). Missing or anything else gives 400 with field `body`.
   - **Read the body:** cap at 1 MB; anything larger gives 400 `body`.
   - **Parse:** `JSON.parse` failure gives 400 `body`. If the result is not a plain object (`null`, an array, or a primitive), also 400 `body`.
   - **Field errors:** gather them into one array, then return them together:
     - Every key that is not `input`, `steps` or `failAttempts` is an error on that key.
     - `input`: missing, not a string, length 0 or over 1000, or `input.trim()===''` is an error.
     - `steps`: if present (`!== undefined`), it must satisfy `typeof v==='number' && Number.isInteger(v) && 1<=v<=20`.
     - `failAttempts`: same check with range 0–5.
     - If an `idempotency-key` header is present (including an empty string) and fails `/^[A-Za-z0-9_-]{1,128}$/`, add an error on field `Idempotency-Key`.
   - If any errors: 400 `{error:{code:'invalid_request', message:'Invalid request', fields}}`.
8. **Create**: apply defaults (steps 5, failAttempts 0) and build `payload`.
   - **With a key:** look up `SELECT * FROM jobs WHERE idempotency_key=?`.
     - Found with the same `payload`: 200 with that job.
     - Found with a different payload: 409 `idempotency_conflict`.
     - Not found: insert and return 201.
     - `DatabaseSync` is synchronous and the server is single-threaded, so check-then-insert cannot race. The UNIQUE constraint protects across restarts. Still catch a UNIQUE error and fall back to the lookup.
   - **Insert values:** `id = crypto.randomUUID()`, `status='queued'`, `attempts=0`, `progress_completed=0`, `next_run_at=Date.now()`.
9. **Worker startup**:
   - Open the db and call `initSchema`.
   - **Recovery:** `UPDATE jobs SET status='queued', progress_completed=0, next_run_at=<now>, updated_at=? WHERE status='running'`. Only one worker exists, so any `running` row is orphaned.
   - Write a heartbeat immediately, then `setInterval` every 500 ms using `INSERT ... ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`.
   - Log `worker started`.
10. **Worker loop** (`while (!stopping)`):
    - **Claim:** in `BEGIN IMMEDIATE`, `SELECT id FROM jobs WHERE status='queued' AND next_run_at<=? ORDER BY seq ASC LIMIT 1`.
      - If found: `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=?`, then COMMIT. Roll back on error.
      - If nothing found: `await sleep(200)` and loop again.
    - **Process:** reload the row and set `n = attempts`.
      - **Transient failure** (`n <= fail_attempts`): `await sleep(100)`. Then:
        - If `n >= 3`: set `status='failed'`, `error='transient failure'`, `result_output=NULL`.
        - Otherwise: set `status='queued'`, `next_run_at=now+500`.
        - In both cases leave `progress_completed` at 0.
      - **Success path:** loop `for i in 1..steps`:
        - `await sleep(100)`.
        - If `stopping`, break out and requeue (see step 11).
        - Otherwise `UPDATE progress_completed=i, updated_at`.
      - **Completion:** set `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`, `error=NULL`.
      - Every write also sets `updated_at`.
11. **Worker SIGTERM/SIGINT**:
    - Set `stopping=true`.
    - If a job is mid-run: `UPDATE jobs SET status='queued', progress_completed=0, next_run_at=now WHERE id=? AND status='running'`. `attempts` stays incremented, because an attempt was started.
    - `clearInterval` the heartbeat, set `last_seen=0` so health shows down at once, call `db.close()`, then `process.exit(0)`.
    - Because the loop checks `stopping` after every 100 ms sleep, shutdown takes at most about 200 ms.
12. **Server SIGTERM/SIGINT**: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Add an `unref`'d 2-second fallback `setTimeout(() => process.exit(0))`.
13. **UI** (`ui/index.html`):
    - **Form:** `<form data-testid="job-form" novalidate>`. `novalidate` is essential so out-of-range values reach the API and its errors show.
    - **Inputs:**
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
      - Do not put `required`, `min` or `max` on them.
    - **Error region:** `<div data-testid="form-error" role="alert"></div>`, empty by default.
    - **List:** `<ul data-testid="job-list">`.
    - **Submit handler:**
      - `preventDefault`.
      - Build the body: `{input: inputEl.value}`. For each numeric field, if `value.trim() !== ''`, set `body.steps = Number(value)` (and likewise `failAttempts`). `NaN` serialises to `null`, which the API rejects with the field name.
      - POST with `Content-Type: application/json`.
      - If the response is not ok: set the error region's textContent to the message plus each `field: message` from `error.fields`, for example `Invalid request — steps: must be an integer from 1 to 20`.
      - On success: clear the error region, clear the input, call `refresh()`.
    - **refresh():**
      - Run every 1000 ms with `setInterval` and once on load.
      - Fetch `/api/jobs` and rebuild the list in API order (newest first).
      - Each job is `<li data-testid="job-item" data-job-id=ID>` containing spans `job-status` (status), `job-progress` (`${completed}/${total}`), `job-result` (`result?.output ?? error ?? ''`) and the input text.
      - Use `textContent` only, never innerHTML with user data.
14. Run `npm run build`, `npm run check:smoke`, `npm run check:contract`.

## Behaviours to verify
- **Build and start:** `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/t/x.db npm run start:server` and `start:worker` in either order. The `/tmp/t` directory gets created.
- **Health:** `curl localhost:3100/health` shows `worker:"up"`. Kill the worker; within 3 seconds it shows `"down"`.
- **Create:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}'` returns 201, status queued, attempts 0, progress `0/3`.
- **Progress:** poll `GET /api/jobs/:id` and watch `progress.completed` climb, ending `completed` with `HI`.
- **Retries:** `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with `error` `"transient failure"`, attempts 3, result null.
- **Validation:** each of these returns 400 `invalid_request` with the right field:
  - `steps:"3"` (field `steps`)
  - `steps:2.5` (field `steps`)
  - `{"input":"   "}` (field `input`)
  - a 1001-character input (field `input`)
  - `{"input":"a","x":1}` (field `x`)
  - `[]`, `nul`, or no content-type (field `body`)
  - `Idempotency-Key: bad key!` (field `Idempotency-Key`)

  Afterwards the job count is unchanged.
- **Idempotency:** with the same key, `{"input":"a"}` followed by `{"input":"a","steps":5,"failAttempts":0}` returns 200 with the same id. A different input with the same key returns 409. Restart the server and replay: still 200 and the same id.
- **Routing:** `/nope` returns 404 `not_found`. `DELETE /api/jobs` and `POST /health` return 405 `method_not_allowed`. `GET /api/jobs/zzz` returns 404.
- **Crash recovery:** submit `steps:20`, `kill -9` the worker mid-run, restart it. The job resumes and completes. Kill the server too and restart; all jobs are listed.
- **Graceful stop:** SIGTERM on both processes; each exits with code 0 in under 2 seconds.
- **UI:** in a browser, submit; the item appears and its status and progress update without a reload. Submit steps=0 and the alert shows text containing `steps`.
- **Checks:** `npm run check:contract` and `npm run check:smoke` pass.

## Risks
- **Imports:** source imports use `.ts` extensions (`./db.ts`). `rewriteRelativeImportExtensions` handles that, so keep the convention. The HTML path `new URL('../ui/index.html', import.meta.url)` resolves correctly from `dist/`.
- **Schema setup:** both processes must run `initSchema`. Without it, the worker starting first finds no table. `busy_timeout` is already set before WAL. Keep claim transactions short and never hold a transaction across an `await`.
- **Type checks:** `typeof v === 'number'` rejects numeric strings. Also reject `NaN` and `Infinity`, which `Number.isInteger` already does. Check `!== undefined` rather than truthiness so that `failAttempts:0` and `steps:null` are handled correctly (null must be an error).
- **Idempotency comparison:** compare canonical payload strings built in a fixed key order, never the raw body.
- **Failed-job fields:** a failed job must have `result: null` and `progress.completed` 0 on failure attempts. `attempts` must be exactly 3. Never let a retry insert a new row.
- **UI validation:** if the form lacks `novalidate`, or the inputs have `min`/`max`/`required`, the browser blocks submission and `form-error` never shows the API error.
- **Error region:** `form-error` must be empty (no whitespace text or placeholder) when there is no error. Clear it on a successful submit.
- **Process exit:** a pending `setInterval` or open server keeps the process alive. Clear timers and call `process.exit(0)` explicitly on SIGTERM. Note that `npm run` wraps node, and the check runner signals the process group, which is fine.
- **Crashed final attempt:** recovery requeues a job orphaned in `running` even if attempts is already 3. The next attempt is then attempt 4 and succeeds when `n > failAttempts`. That is acceptable (it gets "processed again"). Just make sure the failure branch uses `n >= 3` to finalise, so a job can never loop forever.