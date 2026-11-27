# Plan

## Approach
Use one SQLite schema, created idempotently by `openDatabase()` and shared by both processes. It has a `jobs` table and a single-row `heartbeat` table. The server is a plain `node:http` router. It does strict validation that collects every error, and idempotent inserts inside `BEGIN IMMEDIATE` transactions backed by a UNIQUE index on the idempotency key. The worker writes a heartbeat on a timer, puts any `running` jobs back in the queue at startup, and polls the queue every 200 ms. It claims the oldest queued job that is due using a single `UPDATE … RETURNING`, runs its steps with 100 ms sleeps, and writes progress after each step. Retries do not sleep in the worker: a failed attempt sets the job back to `queued` with a `run_after` timestamp. The UI is one static HTML file with vanilla JS. It reloads `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL) and add schema creation with `CREATE TABLE IF NOT EXISTS`. Also add shared helpers: the `JobRow` type, `rowToJob(row)` (builds the exact JSON shape), and `nowIso()`.
- `src/server.ts`: rewrite. Router, body reading, validation, idempotency, health check, UI serving, SIGTERM shutdown.
- `src/validate.ts` (new, optional): `validateSubmission(contentType, rawBody, idemKeyHeader)` returns `{ok, payload}` or `{ok:false, fields}`.
- `src/worker.ts`: rewrite. Heartbeat, recovery, claim loop, processing, retries, SIGTERM.
- `ui/index.html`: form, error region, job list, polling script.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
   ```
   Use positional `?` parameters, and pass `null` rather than `undefined` (node:sqlite rejects `undefined`). `rowToJob` returns: `result = status==='completed' ? {output: result_output} : null`, `error = status==='failed' ? error : null`, `progress = {completed: progress_completed, total: steps}`.
2. **Server routing.** Parse the pathname with `URL`. Known routes:
   - `/` (GET): send the HTML, read once at startup the way it is now.
   - `/health` (GET)
   - `/api/jobs` (GET, POST)
   - `/api/jobs/:id`, matching `^/api/jobs/([^/]+)$` (GET)
   
   A known path with the wrong method returns 405 `method_not_allowed` with an `Allow` header. Anything else returns 404 `not_found`. Wrap each handler in try/catch and send 500 `internal_error` on an exception. Every JSON response uses `application/json; charset=utf-8`.
3. **Health check.** `SELECT last_seen FROM heartbeat WHERE id=1`. `worker` is `"up"` if the row exists and `Date.now() - last_seen < 3000`.
4. **GET list and GET by id.** List with `SELECT * FROM jobs ORDER BY seq DESC`. Do not sort by `created_at`, because timestamps can tie. A missing id returns 404 `not_found`.
5. **POST validation.** Read the whole body, capped at about 1 MB (anything bigger gives `invalid_request` on `body`). Collect errors into `fields`:
   - Idempotency key: if the header is present and fails `/^[A-Za-z0-9_-]{1,128}$/`, add field `Idempotency-Key`. An empty header value counts as present and invalid.
   - Content-Type: take the part before `;`, trim it, lowercase it. It must be `application/json`. If it is missing or different, add `{field:"body"}` and also `{field:"Content-Type"}`, then return 400 without parsing.
   - Parse: `JSON.parse` fails → `body`. The result is not a plain object (null, array, or primitive) → `body`.
   - Unknown keys: one entry per key, using the key's name.
   - `input`: must be a string, `1 ≤ length ≤ 1000`, and `trim() !== ''`. If missing, add field `input`.
   - `steps` and `failAttempts`: if present, they must satisfy `typeof v==='number' && Number.isInteger(v)` and be in range. An explicit `null` is invalid. If absent, use the defaults 5 and 0.
   
   If any errors were collected, return `400 {error:{code:'invalid_request', message:'Invalid request', fields}}`.
6. **POST create and idempotency.** Build the canonical payload string `JSON.stringify({input, steps, failAttempts})` with fixed key order. Then `BEGIN IMMEDIATE`:
   - If a key was sent, select the row with that `idempotency_key`. Same `payload` → COMMIT and return 200 with that job. Different payload → COMMIT and return 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = randomUUID()` (from `node:crypto`), status `queued`, `created_at = updated_at = new Date().toISOString()`, `run_after = 0`, and `idempotency_key = key ?? null`. COMMIT, then return 201 with the job.
   
   Use try/catch around the transaction and ROLLBACK on error.
7. **Server shutdown.** On SIGTERM or SIGINT: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Log to stdout when listening.
8. **Worker startup.**
   - Open the DB.
   - Write the heartbeat right away (`INSERT … ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`), then every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is redone as the same attempt number, which keeps the job within 3 attempts. This is safe because there is only one worker.
9. **Worker loop.** While not stopping, claim a job:
   ```sql
   UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
   WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1)
   RETURNING *
   ```
   If nothing is claimed, `await sleep(200)`. Otherwise process the job:
   - **Failing attempt** (`attempts <= fail_attempts`): sleep 100 ms, leave progress at 0. If `attempts < 3`, set `status='queued'` and `run_after = Date.now() + 500`. Otherwise set `status='failed'`, `error='transient failure'`, `result_output=NULL`.
   - **Normal attempt:** for each step i = 1..steps, sleep 100 ms, then `UPDATE progress_completed=i, updated_at`. At the end set `status='completed'`, `result_output = input.toUpperCase()`, `progress_completed = steps`.
   - Every update sets `updated_at`.
10. **Worker SIGTERM.** Set `stopping=true`. If a job is in progress, stop after the current step and put it back in the queue (`status='queued', attempts=attempts-1, progress_completed=0`). Then `clearInterval`, `db.close()`, `process.exit(0)`. Exit must happen well within 5 s.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing `<input type="text" data-testid="job-input">`, `<input type="number" data-testid="job-steps" value="5">`, `<input type="number" data-testid="job-fail-attempts" value="0">`, and `<button type="submit" data-testid="job-submit">`. Do **not** use `required`, `min`, or `max` attributes, so that invalid values reach the API.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list"></ul>`.
    - **Submit:** `preventDefault`. Build the body as `{input: rawValue}`. For each numeric field, trim the value: if empty, leave it out; if `Number(v)` is finite, send the number; otherwise send the raw string so the API rejects it.
    - **Response:** POST with `Content-Type: application/json`. If the response is not ok, set the error region's text to `error.message` plus one line per field (`field: message`). If ok, clear the error region and the input, then refresh the list.
    - **Rendering:** `refresh()` fetches `/api/jobs` and rebuilds the `<li data-testid="job-item" data-job-id=id>` elements, each with spans `job-status`, `job-progress` (`${completed}/${total}`), and `job-result` (output if completed, error if failed, otherwise empty), plus the input text. Use `textContent` only, never innerHTML with user data. Run it once at load, then `setInterval(refresh, 1000)`.

## Behaviours to verify
- **Build and checks:** `npm run build && npm run check:smoke && npm run check:contract` all pass.
- **Health:** with the worker running, `curl localhost:3000/health` reports `worker:"up"`. Within 3 s of killing the worker it reports `"down"`.
- **Validation:** curl these and expect 400 with the named field in `fields`, and no job created:
  - `{"input":"a","steps":"3"}` → `steps`
  - `{"input":"   "}` → `input`
  - `[1]` → `body`
  - malformed JSON → `body`
  - no Content-Type, or `text/plain` → `body`
  - `{"input":"a","steps":2.5}` → `steps`
  - header `Idempotency-Key: bad key!` → `Idempotency-Key`
- **Idempotency:** POST `{"input":"a"}` with key `k`, then `{"input":"a","steps":5,"failAttempts":0}` with key `k` → 200, same id. `{"input":"b"}` with key `k` → 409. Restart the server and replay → still 200 with the same id.
- **Retries:** `failAttempts:2` ends `completed` with `attempts:3`. `failAttempts:3` ends `failed`, `error:"transient failure"`, `attempts:3`, `result:null`. Poll in between and confirm the status goes back to `queued`.
- **Progress:** submit `steps:20` and poll `GET /api/jobs/:id` every 200 ms. `progress.completed` should rise gradually.
- **Crash recovery:** submit `steps:20`, `kill -9` the worker mid-run, restart it. The job should complete with `attempts:1` (the counter is decremented on recovery and incremented again on the re-run). Completed jobs stay untouched.
- **Shutdown:** `kill -TERM` each process. It should exit 0 within about 1 s.
- **Routing:** `DELETE /api/jobs` → 405. `GET /nope` → 404 `not_found`.
- **UI:** open `/`, submit steps 50 → the error region names `steps`. Submit a valid job → the item appears at the top and its status and progress update without a reload.

## Risks
- **HTML validation blocks submission:** browser attributes like `min`/`max`/`required` stop the form from submitting, so the API error never shows. Use `novalidate` and leave those attributes off.
- **List order:** sorting by `created_at` breaks ties within the same millisecond. Order by `seq`.
- **Recovery overshoot:** re-running a recovered job without adjusting `attempts` can go past 3 attempts. Decrement `attempts` on recovery and on graceful requeue.
- **Heartbeat starvation:** the heartbeat must keep running during long jobs. Use `setInterval`. The step sleeps are async, so the timer gets to run.
- **node:sqlite quirks:** `undefined` bindings throw, so use `null`. `RETURNING` works with `.get()`. Ints come back as numbers, which is fine.
- **Shutdown hangs:** keep-alive connections can stop `server.close()` from finishing, so call `closeAllConnections()`. Make sure SIGTERM handlers actually call `process.exit`.
- **Startup race:** both processes run `CREATE TABLE IF NOT EXISTS` at the same moment. Keep busy_timeout set before the WAL switch, as it is now.
- **UI path:** `dist/server.js` resolves `../ui/index.html` to the repo's `ui/`. Keep that URL-relative read, and don't move the UI file under `src/`.
- **Numeric types:** a JSON string `"3"` must be rejected. Use `typeof === 'number'`, never `Number(...)` coercion, on the server.