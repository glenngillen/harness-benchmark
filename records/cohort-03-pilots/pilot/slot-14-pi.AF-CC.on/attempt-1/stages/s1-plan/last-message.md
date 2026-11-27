# Plan

## Approach
Build everything on the existing scaffold: `src/db.ts` holds the schema and shared row-to-JSON code, `src/server.ts` is a `node:http` API and also serves `ui/index.html`, and `src/worker.ts` is a polling loop. The two processes share state only through SQLite in WAL mode. Each multi-statement change runs inside `BEGIN IMMEDIATE … COMMIT`, so neither process sees half-finished state. The worker writes a heartbeat row every second, and `/health` checks it. Retries reuse the same job row: a failed attempt sets the job back to `queued` with a `run_after` time. When the worker starts, it puts any `running` jobs back in the queue.

## Files
- `src/db.ts`: keep `openDatabase`. Add `migrate(db)` (CREATE TABLE IF NOT EXISTS ×2), `Job` row types, `rowToJob(row)` for the exact API JSON shape, and `nowIso()`. Both processes call `migrate` at startup.
- `src/server.ts`: rewrite. Add routing, validation, idempotent create, list/get, health, JSON errors, and SIGTERM shutdown.
- `src/worker.ts`: rewrite. Add recovery on startup, heartbeat, a claim/process loop with retries, and SIGTERM shutdown.
- `ui/index.html`: a single page with inline JS (form, error region, job list that polls every second).
- Optional `src/validate.ts`: validation helpers. They can live in server.ts instead.

## Steps
1. **Schema** (`db.ts`):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,   -- epoch ms
     idem_key TEXT UNIQUE, payload TEXT);    -- canonical JSON of {input,steps,failAttempts}
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
   ```
   `rowToJob` returns `{id,status,input,steps,failAttempts,attempts,progress:{completed:progress,total:steps},result: status==='completed'?{output}:null, error: status==='failed'?error:null, createdAt, updatedAt}`. Keep `busy_timeout` and set it before WAL, as the file already does.
2. **Server helpers**: `send(res,status,body)` always sets `content-type: application/json; charset=utf-8`. `sendError(res,status,code,message,fields?)`.
3. **Routing**: parse the pathname from `new URL(req.url,'http://x')`.
   - `/` + GET → HTML.
   - `/health` + GET.
   - `/api/jobs` + GET or POST.
   - `/^\/api\/jobs\/([^/]+)$/` + GET.
   - Any other method on those known paths → 405 `method_not_allowed`, with an `Allow` header.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` on unexpected errors.
4. **Health**: `SELECT at FROM heartbeat WHERE id=1`. Return `worker: 'up'` if the row exists and `Date.now()-at < 3000`.
5. **POST validation**: read the whole body. Cap it at about 1 MB and return 400 on `body` if it is larger. Collect errors in a `fields` array, then:
   - **Idempotency-Key header**: if present, it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add field `"Idempotency-Key"`. If the header is an array, treat it as invalid.
   - **Content-Type**: take the media type before `;`, trim it, lowercase it, and require `application/json`. If it is wrong, add field `body` and do not parse the body.
   - **JSON**: `JSON.parse` in a try block. On failure, add field `body` ("malformed JSON"). The parsed value must be a non-null, non-array object, else add `body`.
   - **Unknown keys**: each key not in {input, steps, failAttempts} gets its own field entry.
   - **`input`**: must be present, `typeof === 'string'`, length 1–1000, and `trim() !== ''`.
   - **`steps` / `failAttempts`**: if present (`!== undefined`), require `typeof number`, `Number.isInteger`, and the range. Explicit `null` is invalid.
   - If `fields` is not empty, return 400 `invalid_request` with all of them.
6. **Create** (for the two-process case, use one transaction): build canonical `payload = JSON.stringify({input, steps, failAttempts})` with defaults applied and keys in that fixed order. Then run `BEGIN IMMEDIATE`:
   - If a key was sent, `SELECT * FROM jobs WHERE idem_key=?`. If a row exists and its payload matches, COMMIT and return 200 with that job. If the payload differs, COMMIT and return 409 `idempotency_conflict`.
   - Otherwise INSERT with `id=crypto.randomUUID()`, status `queued`, `run_after=0`, and both timestamps set to `nowIso()`. COMMIT and return 201.
   - ROLLBACK in a `catch`.
   - The UNIQUE constraint on `idem_key` backs this up.
7. **List and get**: list is `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. Get is by id, or 404 `not_found`.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a fallback `setTimeout(...,2000).unref()` exit.
9. **Worker startup**: open the DB, migrate, write the heartbeat (`INSERT … ON CONFLICT(id) DO UPDATE SET at=excluded.at`), and start `setInterval(heartbeat, 1000)`.
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, run_after=0, updated_at=? WHERE status='running'`. Decrementing means the interrupted attempt is rerun with the same attempt number. Then `failAttempts` decides the same outcome, and the total stays capped at 3.
10. **Worker loop**: repeat until stopping.
    - **Claim** inside `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`. If found, `UPDATE … SET status='running', attempts=attempts+1, progress=0, updated_at=?`. COMMIT.
    - If nothing was claimed, `sleep(200)`.
    - **Process** with `n = attempts` after the increment:
      - **Fail branch** (`n <= fail_attempts`): sleep about 100 ms (the "first step"). If `n >= 3`, set status `failed` with `error='transient failure'`, `output=NULL`, progress 0. Otherwise set status `queued` with `run_after=Date.now()+500`, progress 0. Update `updated_at` either way.
      - **Success branch**: for i in 1..steps, `sleep(100)` and then `UPDATE progress=i, updated_at`. Check `stopping` between steps. At the end, set status `completed` with `output=input.toUpperCase()` and `progress=steps`.
11. **Worker shutdown**: the signal handler sets `stopping`. If a job is interrupted mid-run, give it the same treatment as recovery: queued, `attempts-1`, progress 0. Then clear the interval, delete the heartbeat row (optional), `db.close()`, and `process.exit(0)`. Add a 3 s fallback exit timer.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - `<textarea data-testid="job-input">` with no `required` attribute.
      - `<input data-testid="job-steps" value="5">` and `<input data-testid="job-fail-attempts" value="0">`. Use `type="text" inputmode="numeric"`, or `type="number"` with no min/max, so the browser never blocks a submission.
      - `<button data-testid="job-submit" type="submit">`.
      - `<div data-testid="form-error" role="alert">`, empty by default.
    - `<ul data-testid="job-list">`.
    - **Submit**: `preventDefault`. For each numeric field, an empty string means omit it. Otherwise send `Number(v)`; NaN turns into `null` in JSON and the API rejects it. POST with `content-type: application/json`.
      - If the response is not ok, set the error text to `error.message` plus each `field: message` from `error.fields`.
      - If it is ok, clear the error and refresh the list right away.
    - **Rendering**: `refresh()` fetches `/api/jobs` every 1000 ms and renders `<li data-testid="job-item" data-job-id=id>`, each containing `job-status`, `job-progress` (`${completed}/${total}`), `job-result` (output, error, or empty), and the input text. Build it with `textContent` only, never `innerHTML` with job data.
13. Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.

## Behaviours to verify
- **Build and start**: `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/t/x.db npm run start:server` and `start:worker` in either order. `curl /health` should show `"worker":"up"`. Stop the worker, and within about 3 s it should show `"down"`.
- **Create and progress**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hello","steps":3}'` → 201 queued. Poll `GET /api/jobs/:id` and watch `progress.completed` rise. It should end `completed` with `result.output` `"HELLO"`.
- **Retries**: `failAttempts:2` → completed with `attempts` 3. `failAttempts:3` → failed, `error` "transient failure", `attempts` 3, `result` null.
- **Validation**: each of these should return 400 `invalid_request` with the right field(s):
  - `{"input":"a","steps":"3"}`
  - `{"input":"   "}`
  - `{"input":"a","x":1}`
  - `[1]`
  - `{bad`
  - no Content-Type
  - `text/plain`
  - `steps:0`, `steps:21`, `steps:2.5`
  - `failAttempts:6`
  - `Idempotency-Key: bad key!`
- **Idempotency**: key K with `{"input":"a"}` → 201. Then `{"input":"a","steps":5,"failAttempts":0}` → 200 with the same id. Then `{"input":"b"}` → 409. Restart the server and repeat: still 200 and the same id.
- **Routing**: `DELETE /api/jobs` → 405. `GET /nope` → 404 JSON. `GET /api/jobs/zzz` → 404 `not_found`. Every response has an `application/json` content type, except `/`.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job should finish `completed`. Completed jobs keep their `updatedAt` (not reprocessed).
- **Graceful shutdown**: `kill -TERM` each process. Both should exit with code 0 within a few seconds.
- **UI**: open `/`, submit `steps=50`, and `form-error` should mention `steps`. Submit a valid job, and the item's status and progress should update without a reload.

## Risks
- **HTML route clashing with JSON routes**: only `GET /` returns HTML. Everything else must use the JSON helper, including 404, 405 and 500.
- **Node 22 `node:sqlite` API**: there is no `db.transaction()` helper, so use `db.exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK`. `get()` returns `undefined` when there is no row. Bind `null`, not `undefined`.
- **SQLITE_BUSY between processes**: keep `busy_timeout` and keep transactions short. Never `await` inside an open transaction.
- **Treating `0` as missing**: test `steps`/`failAttempts` with `!== undefined`, not truthiness, or `failAttempts: 0` breaks. `typeof NaN === 'number'` can't occur after JSON parsing, but still use `Number.isInteger`.
- **Attempt-count drift after a crash**: without the decrement in recovery, a crash could push `attempts` past 3 or rerun a fail-branch outcome differently. Make sure the "after the third failure" check uses `n >= 3`.
- **Heartbeat during long jobs**: the heartbeat must come from `setInterval`, not the claim loop. Step sleeps are async, so the timer still fires.
- **Newest-first ordering**: `createdAt` can tie, so sort by `seq`, never by timestamp.
- **Browser blocking the UI submission**: don't add `min`, `max` or `required` attributes. Use `novalidate`, or out-of-range values never reach the API.
- **Missing UI file at runtime**: the server runs from `dist/`, so resolve the UI with `new URL('../ui/index.html', import.meta.url)` as the scaffold does.
- **Forbidden files**: don't touch `package.json`, `tsconfig.json`, or anything in `checks/`. Imports must keep the `.ts` extensions, because `rewriteRelativeImportExtensions` is on.