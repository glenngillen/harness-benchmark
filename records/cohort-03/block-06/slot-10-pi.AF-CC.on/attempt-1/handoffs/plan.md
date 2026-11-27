# Plan

## Approach
Keep the three existing modules: `src/db.ts` holds the shared schema and data access, `src/server.ts` is the HTTP API plus the UI, and `src/worker.ts` is the polling worker. Add `src/validate.ts`, which holds pure validation and idempotency normalization. All state lives in SQLite: a `jobs` table and a `worker_heartbeat` table. Every multi-statement change runs inside `BEGIN IMMEDIATE` so both processes stay consistent. The worker writes a heartbeat every 500 ms on its own interval timer. It claims one due queued job at a time (oldest first), runs steps with `await sleep(100)`, writes progress after each step, and puts any `running` jobs back in the queue when it starts. The UI is a single static `ui/index.html` with inline JS that polls `GET /api/jobs` every 1 s.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` schema, a row→job mapper, and data functions: `createJob`, `getJob`, `listJobs`, `claimNextJob`, `updateProgress`, `completeJob`, `failAttempt`, `recoverRunning`, `writeHeartbeat`, `readHeartbeat`.
- `src/validate.ts` (new): `validateSubmission(contentType, rawBody, idemKey)` returns `{ok, payload}` or `{ok:false, fields}`.
- `src/server.ts`: router, JSON error helpers, body reading, idempotent create, health check, SIGTERM handling.
- `src/worker.ts`: heartbeat timer, recovery at startup, claim/process loop, retry scheduling, SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling script.

## Steps
1. **Schema** (in `db.ts`, run by both processes; it is idempotent):
   - `jobs`:
     - `seq INTEGER PRIMARY KEY AUTOINCREMENT`
     - `id TEXT UNIQUE NOT NULL` (from `crypto.randomUUID()`)
     - `status TEXT`, `input TEXT`, `steps INT`, `fail_attempts INT`
     - `attempts INT DEFAULT 0`, `progress INT DEFAULT 0`
     - `output TEXT NULL`, `error TEXT NULL`
     - `run_after INTEGER` (epoch ms)
     - `idem_key TEXT UNIQUE NULL`, `idem_payload TEXT NULL`
     - `created_at TEXT`, `updated_at TEXT` (ISO)
   - Index on `(status, run_after, seq)`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER)`.
   - Concurrent startup: wrap schema creation in try/catch with a retry, or rely on busy_timeout (5000 is already set).
2. **Job mapper**: build the exact shape `{id,status,input,steps,failAttempts,attempts,progress:{completed,total:steps},result: status==='completed'?{output}:null, error: status==='failed'?error:null, createdAt, updatedAt}`.
3. **Validation** (`validate.ts`), collecting every field error:
   - Content-Type: missing, or media type (before `;`, trimmed, lowercased) not `application/json` → field `body`.
   - `JSON.parse` failure → `body`. Result null, an array, or not an object → `body`.
   - Unknown keys → one entry per key.
   - `input`: must be a string, `length` 1–1000, and `input.trim() !== ''`. Store it untrimmed.
   - `steps` / `failAttempts`: if the key is present (even with value `null`), require `typeof === 'number' && Number.isInteger(v)` and the range check. Absent → default.
   - Idempotency-Key header present and not matching `/^[A-Za-z0-9_-]{1,128}$/` → field `Idempotency-Key`.
   - Normalized payload is `JSON.stringify({input, steps, failAttempts})` in a fixed key order.
4. **Server routing**: parse the pathname. Known paths are `/`, `/health`, `/api/jobs` and `/api/jobs/:id` (one segment, decoded). Allowed methods are GET on `/`, `/health` and `/api/jobs/:id`, and GET+POST on `/api/jobs`. Known path with wrong method → 405 `method_not_allowed`. Anything else → 404 `not_found`. Wrap the handler in try/catch and return 500 `internal_error` JSON on failure. Read the body as a Buffer and decode it as UTF-8.
5. **POST create** (in one `BEGIN IMMEDIATE` transaction):
   - If a key is given, `SELECT` by `idem_key`.
     - Found with equal `idem_payload` → COMMIT and return 200 with that job.
     - Found with a different payload → 409 `idempotency_conflict`.
     - Otherwise insert with `status='queued'`, `run_after=0`, and return 201.
   - Use try/finally to ROLLBACK on error. As a backstop, if the UNIQUE constraint fails, re-select and apply the same comparison.
6. **GET list / get**: `ORDER BY seq DESC` for newest first. Unknown id → 404 `not_found`. All JSON responses use `application/json; charset=utf-8`.
7. **Health**: `worker = Date.now() - beat_at < 3000 ? 'up' : 'down'`. A missing row means down.
8. **Worker start**:
   - Open the DB and write a heartbeat immediately, then `setInterval(writeHeartbeat, 500)`.
   - `recoverRunning()`: `UPDATE jobs SET status='queued', progress=0, attempts=MAX(attempts-1,0), run_after=0, updated_at=now WHERE status='running'`. The interrupted attempt is un-counted so the 3-attempt cap and the attempt numbering for `failAttempts` stay correct. Run this before the loop starts. The worker is single, so it is safe.
9. **Worker loop** (while `!stopping`):
   - Claim in one IMMEDIATE transaction: `SELECT ... WHERE status='queued' AND run_after<=now ORDER BY seq LIMIT 1`, then `UPDATE` it to `status='running', attempts=attempts+1, progress=0, updated_at`.
   - Nothing claimed → `sleep(200)`.
   - Attempt n = new `attempts`. If `n <= fail_attempts`:
     - `n >= 3` → `status='failed'`, `error='transient failure'`, `output=NULL`.
     - Otherwise → `status='queued'`, `progress=0`, `run_after=now+500`.
   - Else, for each step: `await sleep(100)`, then `UPDATE progress=i`. Finally set `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
   - Every terminal or progress write includes `WHERE id=? AND status='running'`.
10. **Worker SIGTERM**: set `stopping`. Mid-job, either finish the current step and leave the job `running` (recovery requeues it), or simply exit. Then clear the interval, `db.close()` and `process.exit(0)` within about 1 s. A simple approach: on signal, clear the interval, close the db, and exit immediately. The job stays running and gets recovered.
11. **Server SIGTERM/SIGINT**: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`, plus a fallback `setTimeout(...).unref()`.
12. **UI**:
    - `<form data-testid="job-form">` containing:
      - `input[data-testid=job-input]` (text)
      - `input[type=number][data-testid=job-steps]` (value 5)
      - `input[type=number][data-testid=job-fail-attempts]` (value 0)
      - `button[data-testid=job-submit]`
    - `<div data-testid="form-error" role="alert"></div>`
    - `<ul data-testid="job-list">`
    - On submit, call `preventDefault`. Build the body with `input` as the raw string. For each numeric field, a blank value omits the key; otherwise send `Number(value)`. If `Number(value)` is NaN, send the raw string so the API rejects it. Do not put `required`, `min` or `max` on the fields, and set `novalidate` on the form, so invalid values reach the API.
    - POST with `Content-Type: application/json`.
    - Not ok → set the error region's text to `error.message` plus each `field: message`.
    - Ok → clear the error region and refresh.
    - Poll `GET /api/jobs` every 1000 ms. Render `li[data-testid=job-item][data-job-id]` items containing:
      - `span[data-testid=job-status]`
      - `span[data-testid=job-progress]` showing `c/t`
      - `span[data-testid=job-result]` showing the output, or the error text, or empty
    - Use `textContent` only (never innerHTML) for user data.

## Behaviours to verify
- Build and run: `npm run build && npm run check:smoke && npm run check:contract`; both suites must pass.
- Health: start only the server → `worker: down`. Start the worker → `up` within 1 s. Kill the worker → `down` after about 3 s.
- Validation: use curl to send `{"input":"a","steps":"3"}`, `{"input":"   "}`, `{"x":1,"input":"a"}`, a malformed body, `[]`, no Content-Type, `text/plain`, `steps:1.5`, `steps:21`, `failAttempts:6`, and the header `Idempotency-Key: bad key`. Each should return 400 with the right `fields`, and `GET /api/jobs` should not grow.
- Idempotency: POST `{"input":"a"}` with key K → 201. Repeat with `{"input":"a","steps":5,"failAttempts":0}` → 200 with the same id. Send `{"input":"b"}` with K → 409. Restart the server and repeat → still 200.
- Progress: POST `steps:20` and poll the job; `progress.completed` increases while the status is `running`.
- Retries: `failAttempts:2` → completed with attempts 3. `failAttempts:3` → failed, `error` set to `"transient failure"`, attempts 3, result null.
- Crash recovery: submit `steps:20`, `kill -9` the worker mid-run, restart it → the job completes. Completed jobs keep their `updatedAt` unchanged across restarts.
- Routing: `DELETE /api/jobs` → 405; `GET /nope` → 404; `GET /api/jobs/xyz` → 404 `not_found`.
- UI: open `/`, submit a job, watch the status and progress update. Submit `steps` 50 → `form-error` mentions `steps`.

## Risks
- **Node 22 `node:sqlite` API**: use `db.prepare(sql).get/all/run`. Named params need the `$name` or `:name` syntax; positional `?` is simpler. A `get` with no row returns `undefined`. Values come back as number or string.
- **Imports**: keep `.ts` import extensions, which `rewriteRelativeImportExtensions` turns into `.js`. The UI path `../ui/index.html` resolves relative to `dist/`, which works.
- **Non-integer numbers**: `typeof true`, `NaN` and `Infinity` can't come from JSON, but booleans and `null` can. Reject both via the `typeof` check. Never coerce strings.
- **Duplicate jobs from idempotency races**: avoid them with the UNIQUE column plus the transaction. Never compare raw bodies; compare the normalized payload.
- **Heartbeat starvation**: the heartbeat must not depend on the job loop. Use `setInterval`. Steps are async sleeps, so the timer still fires.
- **Lock contention**: DB-locked errors are possible. busy_timeout covers most cases. Keep transactions short and never `await` inside one.
- **Attempt count after a crash**: blindly re-claiming after a crash during attempt 3 would push `attempts` to 4. The decrement in recovery prevents that.
- **Shutdown**: SIGTERM is sent to the npm process group. Both processes must exit promptly. Don't leave intervals or keep-alive sockets holding the event loop open; use `closeAllConnections` and `process.exit`.
- **UI fields**: HTML `min`/`max`/`required` would block submission, so omit them. `form-error` must be empty (not whitespace text) when there is no error.
- **Job ordering**: `seq` gives deterministic oldest-first and newest-first ordering. Don't rely on ISO timestamps, because they tie within the same millisecond.