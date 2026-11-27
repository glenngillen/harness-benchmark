# Plan

## Approach
Keep the current layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` is a `node:http` server, `src/worker.ts` is a polling loop, and `ui/index.html` is one static page with inline JS. All state lives in SQLite (WAL plus busy_timeout, already set up). That includes a `jobs` table with a scheduled `run_at` for retries, a UNIQUE idempotency-key column, and a `worker_heartbeat` row that the server reads for `/health`. The worker claims jobs inside `BEGIN IMMEDIATE` transactions and writes progress after every step. When it starts up, it requeues any job left `running`. Relative imports keep the `.ts` extension (e.g. `./db.ts`) because tsconfig uses `rewriteRelativeImportExtensions`.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` schema, a `Job` row→JSON mapper, `nowIso()` and a small `tx(db, fn)` helper (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`).
- `src/server.ts`: routing, validation, idempotency, health, static UI, SIGTERM handling.
- `src/worker.ts`: heartbeat, recovery, claim loop, step processing, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, 1 s polling.
- Optional `src/validate.ts`: a pure validation function, if that keeps the server tidy.

## Steps
1. **Schema** (in `db.ts`, run by both processes on open; it is idempotent):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INT, fail_attempts INT, attempts INT DEFAULT 0, progress INT DEFAULT 0, output TEXT NULL, error TEXT NULL, idem_key TEXT UNIQUE NULL, created_at TEXT, updated_at TEXT, run_at INTEGER NOT NULL /*epoch ms*/)`, plus an index on `(status, run_at, seq)`.
   `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER)`.
   Run the schema exec after the PRAGMAs.
2. **Mapper** `toJson(row)`: `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Timestamps come from `new Date().toISOString()`.
3. **Server routing**: parse the pathname. Known paths are `/`, `/health`, `/api/jobs` and `/^\/api\/jobs\/([^/]+)$/`. A wrong method on any of these returns 405 `method_not_allowed`. Anything else returns 404 `not_found`. Every JSON response uses `application/json; charset=utf-8`. Wrap the handler in try/catch and return 500 `internal_error` on failure.
4. **`GET /health`**: read `beat_at`. Return `worker: 'up'` if `Date.now() - beat_at < 3000`, otherwise `'down'`.
5. **`GET /api/jobs`**: `ORDER BY seq DESC`. **`GET /api/jobs/:id`**: decode the id with `decodeURIComponent` inside a try block. Return 404 `not_found` if the job is missing.
6. **`POST /api/jobs` validation** (collect all field errors, return 400 `invalid_request` with a `fields` array):
   - Content-Type: take the media type before `;`, trim and lowercase it, and require `application/json`. Missing or other values → field `body`. Still read and discard the request body.
   - Idempotency-Key header: if present and it fails `^[A-Za-z0-9_-]{1,128}$` → field `Idempotency-Key`.
   - Read the whole body. `JSON.parse` failure (including an empty body) → `body`. Not a plain object (null, an array, a primitive) → `body`.
   - Unknown keys → one entry per key, named after the key.
   - `input`: must be `typeof 'string'`, have length 1–1000, and have `trim() !== ''`. Store it untrimmed.
   - `steps` / `failAttempts`: if present, must be `typeof 'number'`, `Number.isInteger`, and in range (1–20 / 0–5). Apply defaults 5 / 0.
7. **Create with idempotency**: use `tx` (BEGIN IMMEDIATE). If a key was sent, `SELECT` by `idem_key`. If a row exists and its `input`, `steps` and `fail_attempts` all equal the normalized payload, return 200 with that job. If they differ, return 409 `idempotency_conflict`. Otherwise `INSERT` with `id = randomUUID()`, `status='queued'`, `run_at=Date.now()`, and return 201. The UNIQUE constraint backs this up; if a constraint error occurs, re-run the lookup.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Keep the existing `readFileSync` of `ui/index.html` (the path is relative to `dist/`, so `../ui/index.html` still resolves).
9. **Worker startup**:
   - Open the DB and write the heartbeat right away, then every 500 ms with `setInterval` (`INSERT ... ON CONFLICT(id) DO UPDATE`).
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, run_at=now, updated_at=now WHERE status='running'`. The interrupted attempt is redone, not counted twice. This keeps `attempts ≤ 3` and keeps the failAttempts arithmetic correct. It is safe because there is a single worker.
10. **Worker loop**: repeat while not stopping.
    - Claim in `tx`: `SELECT ... WHERE status='queued' AND run_at<=? ORDER BY seq ASC LIMIT 1`, then `UPDATE SET status='running', attempts=attempts+1, progress=0, updated_at`. If nothing is claimed, sleep 200 ms.
    - For a claimed job with `n = attempts`: if `n <= fail_attempts`, the attempt fails immediately (before any progress). If `n >= 3`, set `status='failed', error='transient failure'`. Otherwise set `status='queued', run_at=now+500`.
    - Otherwise, for each step i = 1..steps: `await sleep(100)`. If stopping, break. Then `UPDATE progress=i, updated_at`.
    - After the last step: `status='completed', output=input.toUpperCase(), progress=steps`.
    - Every update after the claim includes `WHERE id=? AND status='running'`.
11. **Worker SIGTERM**: set `stopping`. If a job is mid-flight, requeue it the same way recovery does (`attempts-1`, progress 0, queued). Then clear the interval, close the DB and exit 0. A loop that checks `stopping` each step exits within about 100 ms.
12. **UI** (`ui/index.html`):
    - Use `<form data-testid="job-form" novalidate>` with no HTML `required`/`min`/`max` blocking, so the API's validation errors show up.
    - Fields: `job-input` (text), `job-steps` (`type=number`, value 5), `job-fail-attempts` (`type=number`, value 0), `job-submit`. Add `<div data-testid="form-error" role="alert"></div>`.
    - On submit, `preventDefault`. Build the body: `input` as a string. For each numeric field, if the value is empty, omit it. If `Number(v)` is finite, send the number. Otherwise send the raw string so the API rejects it.
    - POST as JSON. If the response is not OK, set form-error text to the message plus each `field: message`. If it is OK, clear form-error and refresh.
    - Poll `GET /api/jobs` every 1000 ms. Render `<ul data-testid="job-list">` with `<li data-testid="job-item" data-job-id>` that contains `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, else empty). Set values with `textContent` (no innerHTML of user input) and only re-render the list, never the form.

## Behaviours to verify
- Build and start: `npm run build`, then `npm run start:server` and `npm run start:worker` in either order. Check `curl localhost:3000/health` shows `worker` `up`, and `down` about 3 s after killing the worker.
- Contract checks: `npm run check:smoke` and `npm run check:contract` must pass.
- Validation: POST with `steps:"2"`, `failAttempts:7`, an extra `colour`, a missing `input`, `"   "` as input, `[]`, malformed JSON, `text/plain` Content-Type, and a bad Idempotency-Key. Each returns 400 with the right `fields[].field`, and the job count does not change.
- Idempotency: the same key with `{input:"a"}` and then `{input:"a",steps:5,failAttempts:0}` returns 201, then 200 with the same id. A different input returns 409. Restart the server and replay: still 200.
- Progress: a `steps:10` job shows `progress.completed` rising when you poll `GET /api/jobs/:id`.
- Retries: `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with attempts 3, error `"transient failure"` and result null. Exactly one job exists per submission.
- Crash recovery: start a `steps:20` job, `kill -9` the worker mid-run and restart it. The job completes within about 10 s plus its run time, with attempts ≤ 3. Completed jobs are never touched again (`updatedAt` stays the same).
- SIGTERM: both processes exit quickly with code 0.
- UI: open `/`, submit an empty input and see `input` in form-error. Submit a valid job and watch status and progress update without a reload.

## Risks
- **Importing without `.ts`**: imports must stay `./db.ts`, or the build/runtime resolution breaks. Do not edit tsconfig.
- **SQLITE_BUSY between processes**: use `BEGIN IMMEDIATE` for read-then-write sequences and keep transactions short. Never hold a transaction across an `await`.
- **Double-counting attempts after a crash**: decrement on recovery, as described above.
- **Browser validation hiding API errors**: use `novalidate` and avoid `required`/`min`/`max`.
- **Content-Type with charset** (`application/json; charset=utf-8`) must be accepted. Check that `typeof x === 'number'` rejects booleans and numeric strings.
- **Responses must be JSON**: 404/405 must also be JSON. Only `GET /` returns HTML.
- **Slow shutdown**: the heartbeat interval or open HTTP keep-alive connections can keep a process alive. Clear the interval and call `closeAllConnections`, then `process.exit(0)`.
- **Retry delay**: it must be at least 250 ms and below 2 s. Use 500 ms, and keep the idle poll at 200 ms or less so new jobs start within 1 s.