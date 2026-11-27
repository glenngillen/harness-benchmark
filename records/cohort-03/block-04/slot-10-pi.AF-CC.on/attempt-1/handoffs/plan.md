# Plan

## Approach
Keep the three-file layout. `src/db.ts` owns the schema, the row-to-JSON mapping and shared queries. `src/server.ts` is a `node:http` router that validates requests and reads and writes jobs. `src/worker.ts` is a polling loop that claims due queued jobs, runs the steps and writes progress after each one, and writes a heartbeat every second. Retries are scheduled with a `run_after` column, so no timers are needed in the server. On startup the worker re-queues any job left `running` by a dead worker. `ui/index.html` is a single static page with inline JS that polls `GET /api/jobs` every second and updates elements in place.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Also run `CREATE TABLE IF NOT EXISTS` for `jobs` and `heartbeat`, and export `rowToJob(row)` and `nowIso()`.
- `src/server.ts`: rewrite. Add the router, body reading, validation, idempotency, health, static UI and SIGTERM handling.
- `src/worker.ts`: rewrite. Add recovery, the claim/process loop, retries, the heartbeat and graceful shutdown.
- `ui/index.html`: the form, the error region, the job list and the polling script.

## Steps
1. **Schema** (in `openDatabase`, both processes; `IF NOT EXISTS` makes it safe for both to run):
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
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE,
     payload TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), beat_at INTEGER NOT NULL);
   ```
   `rowToJob` builds the exact JSON shape:
   - `result` is `{output}` only when status is `completed`, otherwise `null`.
   - `error` is the string only when status is `failed`, otherwise `null`.
   - `progress` is `{completed: progress_completed, total: steps}`.
   - Timestamps come from `new Date().toISOString()`.
   - Keep imports using the `.ts` extension, matching the existing code (tsconfig rewrites them).
2. **Server helpers:**
   - `send(res, status, body)` always sets `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - `readBody(req)` collects chunks. Cap the size at about 1 MB; if it is exceeded, return 400 `invalid_request` with field `body`.
3. **Routing.** Parse the pathname with `new URL`.
   - `/health`: GET only.
   - `/`: GET only. Serve the UI HTML (the existing `../ui/index.html` relative to `import.meta.url` already works from `dist/`).
   - `/api/jobs`: GET and POST.
   - `/api/jobs/:id`: GET only. Match with `^/api/jobs/([^/]+)$` and `decodeURIComponent` the id.
   - A known path with the wrong method gets 405 `method_not_allowed` with an `Allow` header. Anything else gets 404 `not_found`.
   - Wrap the handler in try/catch; on an exception send 500 `internal_error`.
4. **POST validation.** Collect every problem into `fields[]`, then return 400 if there are any.
   - Check `Idempotency-Key` (`req.headers['idempotency-key']`) against `^[A-Za-z0-9_-]{1,128}$` when the header is present. Report it as field `"Idempotency-Key"`.
   - Content-Type: take the part before `;`, trim and lowercase it. If it is not `application/json`, report field `body`.
   - Parse JSON in try/catch. Malformed JSON reports `body`. So does a body that is null, an array or a primitive.
   - Unknown keys: each one is reported under its own name.
   - `input`: must be a string, `length` 1–1000, and `trim() !== ''`. A missing `input` is reported as field `input`. Store it unmodified.
   - `steps` and `failAttempts`: absent (`undefined`) means use the default. Otherwise require `typeof === 'number' && Number.isInteger(v)` and the range. Strings such as `"3"` and `null` are rejected.
   - If the body-level checks fail, skip the per-field checks. Still include the Idempotency-Key error if there is one.
5. **Create and idempotency.**
   - The canonical payload is `JSON.stringify({input, steps, failAttempts})`, built after defaults are applied, in a fixed key order.
   - Inside `BEGIN IMMEDIATE ... COMMIT` (ROLLBACK on error):
     - If there is a key, `SELECT` by `idempotency_key`. If a row is found, return 200 with that job when the payload matches; otherwise return 409 `idempotency_conflict` and do not insert.
     - Otherwise `INSERT` with `id = crypto.randomUUID()`, status `queued`, attempts 0, `run_after = 0` and the payload. Return 201.
   - The UNIQUE constraint makes sure a key never creates two jobs, even across restarts.
6. **Reads.**
   - `GET /api/jobs`: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs}`.
   - `GET /api/jobs/:id`: by id, or 404 `not_found`.
   - `/health`: read `heartbeat.beat_at`. `worker` is `"up"` if `Date.now() - beat_at < 3000`, otherwise `"down"`. A missing row means down.
7. **Server shutdown.** On SIGTERM/SIGINT: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Add a 2 s fallback `setTimeout(...).unref()` exit.
8. **Worker startup.**
   - Open the DB and start the heartbeat immediately: `INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=?`, using `setInterval` every 1000 ms.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is undone, so the retry and failAttempts rules stay deterministic and attempts never goes above 3.
9. **Worker loop** (`while (!stopping)`):
   - Claim with `SELECT * FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY seq ASC LIMIT 1`. If nothing is due, `await sleep(200)` and loop again.
   - Start the attempt: `n = attempts + 1`, then `UPDATE ... SET status='running', attempts=n, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`.
   - Simulated failure, when `n <= fail_attempts`: `await sleep(100)`, then:
     - if `n < 3`: `status='queued', run_after=Date.now()+500, progress_completed=0`;
     - otherwise: `status='failed', error='transient failure', result_output=NULL`.
   - Normal run: for i = 1..steps, `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. After the last step set `status='completed', result_output=input.toUpperCase()`.
   - Before each step, check `stopping`. If set, re-queue the job the same way recovery does (attempts−1, progress 0, status queued) and break out of the loop.
10. **Worker shutdown.** SIGTERM/SIGINT sets `stopping`. After the loop: clear the interval, set `beat_at=0` (so health reports down), `db.close()`, `process.exit(0)`. The current step finishes within about 100 ms.
11. **UI** (`ui/index.html`):
   - Markup:
     - `<form data-testid="job-form" novalidate>`.
     - `<input data-testid="job-input" type="text">`.
     - `<input data-testid="job-steps" type="number" value="5">`.
     - `<input data-testid="job-fail-attempts" type="number" value="0">`.
     - `<button data-testid="job-submit" type="submit">`.
     - `<div data-testid="form-error" role="alert"></div>`, empty by default.
     - `<ul data-testid="job-list">`.
   - On submit, `preventDefault()` and build the body:
     - `input` is sent as the raw string.
     - For each numeric field: if the trimmed value is empty, omit it. If `Number(v)` is finite, send the number. Otherwise send the raw string, so the API rejects it.
   - POST with `Content-Type: application/json`.
     - On a non-2xx response, fill `form-error` with `error.message` plus one line per field (`field: message`) using `textContent`.
     - On success, clear `form-error`, reset the input and refresh the list immediately.
   - Every 1000 ms `refresh()` fetches `/api/jobs` and reconciles in place, keyed by `data-job-id`:
     - Create missing `<li data-testid="job-item" data-job-id>` elements, each containing spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, otherwise empty).
     - Order the items newest first, as the API returns them.
     - Remove items that are gone.
     - Always use `textContent`, never innerHTML with job data.

## Behaviours to verify
- **Build and checks:** run `npm run build`, then `npm run check:smoke` and `npm run check:contract` (the checks start both processes themselves).
- **Health:** start the server only and `curl /health` shows `worker: down`. Start the worker and it shows `up` within about 1 s. SIGTERM the worker and it shows `down` within 3 s.
- **Create:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}' :3000/api/jobs` returns 201 with status queued, attempts 0 and progress 0/3. Polling GET shows progress rising, then completed with output `HI`.
- **Validation:** each of these returns 400 with the listed field:
  - `steps:"2"` → `steps`
  - `failAttempts:7` → `failAttempts`
  - `colour` → `colour`
  - missing input → `input`
  - `input:"   "` → `input`
  - `[]` → `body`
  - `{bad` → `body`
  - `text/plain` Content-Type → `body`
  - key `a b` → `Idempotency-Key`

  The job count is unchanged afterwards.
- **Idempotency:** the same key and payload, with and without explicit defaults, returns 200 with the same id. A changed input returns 409. Restart the server and replay: still 200 with the same id.
- **Retries:** `failAttempts:1, steps:1` completes with attempts 2. `failAttempts:2` completes with attempts 3. `failAttempts:3` ends failed, with error `transient failure`, attempts 3 and result null. Exactly one job is listed.
- **Crash recovery:** submit `steps:20`, `kill -9` the worker mid-run, restart it, and the job completes. Kill both processes with -9, restart them, and all jobs are still there. Completed jobs keep the same `updatedAt` (not reprocessed).
- **Routing:** `DELETE /api/jobs/x` returns 405, `GET /nope` returns 404 `not_found`, and every response is JSON.
- **UI:** in a browser, submit with steps 50 and `form-error` mentions `steps`. A valid submission appears at the top and its status and progress update without a reload.

## Risks
- **Missing heartbeat:** the worker's async sleep loop must not block the heartbeat interval; the DB calls are synchronous but short. Write the first heartbeat before recovery so health shows up within 1 s.
- **Ordering:** sort by `seq`, not `created_at`, because ISO timestamps tie within the same millisecond.
- **Content-Type:** accept `application/json; charset=utf-8`; a strict equality check rejects it.
- **Numeric validation:** `typeof null === 'object'`, and `Number("3")` would accept strings; use strict `typeof v === 'number'` and `Number.isInteger`.
- **Idempotency write:** do the check and insert in one transaction; don't insert first and then catch the UNIQUE error with an incomplete response path.
- **Attempt counts after a crash:** if recovery forgets to decrement `attempts`, a crash during attempt 3 leads to attempt 4. Decrement in recovery and in the SIGTERM re-queue.
- **Retry delay:** it must be between 250 ms and 2 s; 500 ms is used. The idle poll (200 ms) keeps pickup under 1 s.
- **Shutdown speed:** the process must exit promptly on SIGTERM. Close keep-alive connections (`closeAllConnections`) or the server can hang.
- **UI number fields:** keep `novalidate` on the form, or the browser blocks out-of-range values and the API's error never shows. Don't add `min`/`max`/`required` that the browser enforces.
- **Fixed files:** do not edit `package.json`, `tsconfig.json` or `checks/`. Everything compiles with tsc strict, so type the `node:sqlite` rows explicitly (cast `as Record<string, any>`).