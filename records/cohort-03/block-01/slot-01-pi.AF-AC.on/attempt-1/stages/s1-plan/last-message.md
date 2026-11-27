# Plan

## Approach
Keep the three-file layout (`src/db.ts`, `src/server.ts`, `src/worker.ts`) plus `ui/index.html`. Both processes share the schema from `db.ts`. The schema has two tables: `jobs`, and a one-row `worker_heartbeat`. The server is a plain `node:http` router that validates requests, handles idempotency in a transaction, and serializes rows into the job JSON shape. The worker runs one polling loop. It claims the oldest runnable queued job in a `BEGIN IMMEDIATE` transaction, runs the steps with async sleeps and writes progress after each one, and schedules retries using a `run_after` timestamp. It also writes a heartbeat once a second. The UI is a single static page with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (it already does mkdir, busy_timeout and WAL). Add `CREATE TABLE IF NOT EXISTS` for the schema, plus shared helpers: `rowToJob(row)` and `nowIso()`.
- `src/server.ts`: rewrite it with a router, validation, idempotency, health, the UI route and SIGTERM handling.
- `src/worker.ts`: rewrite it with recovery, the claim loop, step processing, retries, the heartbeat and SIGTERM handling.
- `ui/index.html`: the form, error region, job list and polling script, all inline.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas, using `db.exec`):
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
     run_after INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS worker_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), last_seen INTEGER NOT NULL);
   ```
   - `rowToJob` returns `{id, status, input, steps, failAttempts, attempts, progress: {completed, total: steps}, result: status === 'completed' ? {output} : null, error: status === 'failed' ? error : null, createdAt, updatedAt}`.
   - Keep the `.ts` import extensions (tsconfig rewrites them).
2. **Server helpers**:
   - `send(res, status, body)` sets `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - `readBody(req)` collects chunks into a utf8 string, with a 1 MB cap (over the cap gives 400 with field `body`).
3. **Routing**: use `pathname` from `new URL`.
   - `/` allows GET and serves the UI HTML.
   - `/health` allows GET.
   - `/api/jobs` allows GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` allows GET.
   - A known path with the wrong method gets 405 `method_not_allowed`. Anything else gets 404 `not_found`.
   - Wrap the handler in try/catch so unexpected errors return 500 `internal_error` as JSON.
4. **Health**: `SELECT last_seen FROM worker_heartbeat WHERE id = 1`. `worker` is `'up'` if the row exists and `Date.now() - last_seen < 3000`.
5. **POST validation**: collect a `fields` array and return 400 `invalid_request` if it is non-empty.
   - **Idempotency key**: if the header is present (including an empty string), it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add field `Idempotency-Key`. Collect this error together with the body errors.
   - **Content-Type**: take the part before `;`, trimmed and lowercased. It must be `application/json`. If it is missing or different, add field `body` and skip parsing.
   - **Parsing**: `JSON.parse` failure → `body`. `null`, an array or a non-object → `body`.
   - **Unknown keys**: each key not in {input, steps, failAttempts} is listed under its own name.
   - **input**: must be `typeof === 'string'`, with length 1–1000, and `input.trim().length > 0`. If missing, the field is `input`.
   - **steps / failAttempts**: if present (`!== undefined`), must satisfy `typeof === 'number' && Number.isInteger(v)` and be in range. Otherwise apply the default (5 / 0).
6. **Create** (no `await` between reading the body and responding; DatabaseSync is synchronous):
   - `payload = JSON.stringify({input, steps, failAttempts})`, with keys in that fixed order.
   - If a key is present: `BEGIN IMMEDIATE`, then `SELECT` by `idempotency_key`.
     - Found and payloads equal → COMMIT, 200 with the job.
     - Found and different → COMMIT, 409 `idempotency_conflict`.
     - Not found → INSERT, COMMIT, 201.
     - Use try/catch with ROLLBACK.
   - Without a key, just INSERT with `idempotency_key` NULL.
   - INSERT uses `id = crypto.randomUUID()`, status `queued`, and `created_at = updated_at = new Date().toISOString()`.
   - `GET /api/jobs` uses `ORDER BY seq DESC`. `GET /api/jobs/:id` uses `decodeURIComponent` on the id, and returns 404 `not_found` when the job is missing.
7. **Server SIGTERM/SIGINT**: `server.close()`, then `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Log once it is listening.
8. **Worker startup**:
   - Open the DB and write the heartbeat right away: `INSERT ... ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`.
   - Repeat the heartbeat with `setInterval(..., 1000)`.
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. There is only one worker, so any `running` row is orphaned. The interrupted attempt does not count, so attempts stay ≤ 3 and the failAttempts numbering stays consistent.
9. **Worker loop** (`while (!stopping)`):
   - **Claim** in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY seq LIMIT 1`. If a row is found: `UPDATE SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?`. COMMIT.
   - If nothing was claimed, `await sleep(100)` and loop.
   - **Process**, with `n` = the new attempts value:
     - **Attempt fails** (`n <= fail_attempts`): `await sleep(100)`, then:
       - if `n >= 3`: set status `failed`, error `'transient failure'`, result_output NULL;
       - otherwise: set status `queued`, `run_after = Date.now() + 500`.
     - **Attempt succeeds**: for each step i = 1..steps, `await sleep(100)`, check `stopping` (if set, break and let shutdown requeue), then `UPDATE progress_completed = i, updated_at`.
     - **Finish**: set status `completed`, `result_output = input.toUpperCase()`, `progress_completed = steps`.
10. **Worker SIGTERM/SIGINT**:
    - Set `stopping`. If a job is mid-run, requeue it with the same SQL as recovery (restricted to that id), then clear the interval and `db.close()`.
    - Let the loop exit, then call `process.exit(0)`. Keep sleeps short (≤ 100 ms) so shutdown is fast.
11. **UI** (`ui/index.html`):
    - Form `data-testid="job-form"` with `novalidate`, containing:
      - text `job-input`;
      - `job-steps` (type text or number, default value 5);
      - `job-fail-attempts` (default 0);
      - button `job-submit` (type submit).
    - `<div data-testid="form-error" role="alert"></div>`, and `<ul data-testid="job-list">`.
    - **On submit** (`preventDefault`):
      - Build the body as `{input}`. For each numeric field: if the trimmed value is empty, omit it. Else if `Number(v)` is finite, send the number. Else send the raw string, so the API rejects it.
      - POST with `Content-Type: application/json`.
      - If the response is not ok: put `error.message` plus one line per field (`<field>: <message>`) into form-error, using textContent.
      - If it is ok: clear form-error, clear the input, and refresh.
    - **Polling**: `refresh()` fetches `/api/jobs` every 1000 ms and on load. It re-renders the `<li data-testid="job-item" data-job-id=...>` elements, each with spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (result.output if completed, error if failed, else empty).
    - Use textContent only, so there is no XSS. Only re-render the list, never the form.

## Behaviours to verify
- **Build and start**: `npm run build && (PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server &) ; DATABASE_PATH=/tmp/jt/x.db npm run start:worker`. The `/tmp/jt` directory should get created.
- **Health**: `curl localhost:3100/health` gives `up` with the worker running. About 3 s after killing the worker it gives `down`.
- **Create and complete**: POST `{"input":"hello","steps":3}` returns 201, queued, attempts 0. Polling `GET /api/jobs/:id` shows progress 1/3, 2/3, then completed with `HELLO`.
- **Validation**:
  - `steps:"2"`, `failAttempts:7`, `colour:"blue"`, a missing input, `"   "`, `steps:2.5`, malformed JSON, `[]`, and a text/plain content type all return 400 and list the right field.
  - A bad `Idempotency-Key: a b` gives field `Idempotency-Key`.
  - The job count is unchanged afterwards.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 200 with the same id. A different input returns 409. The key still replays after restarting the server.
- **Retries**: `failAttempts:1` gives completed with attempts 2. `failAttempts:2` gives completed with attempts 3. `failAttempts:3` gives failed, `"transient failure"`, attempts 3, result null. In each case only one job is listed.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job completes. Completed jobs stay untouched.
- **404 / 405**: `GET /nope` gives 404 `not_found`. `DELETE /api/jobs` gives 405.
- **Checks**: run `npm run check:smoke` and `npm run check:contract`.
- **UI**: open `/`, submit `steps` = 50 and the error shows "steps". A valid job updates status and progress live.

## Risks
- **SQLITE_BUSY between processes**: keep busy_timeout and WAL, use short `BEGIN IMMEDIATE` transactions, and never hold a transaction across an `await`.
- **Heartbeat stalls**: the heartbeat must use `setInterval`, independent of job processing. Steps are async sleeps, so the timer still fires.
- **Leaking fields**: never return `result`/`error` for the wrong status. Always go through `rowToJob`.
- **Payload comparison**: idempotency must compare the payload after defaults are applied, serialized in a fixed key order, not the raw body.
- **Type checks**: `typeof v === 'number'` must be checked before `Number.isInteger`, because numeric strings must fail. Validate input length with `.length`, not bytes.
- **Browser validation**: the form needs `novalidate` and no `required`/`min`/`max`, otherwise the browser blocks invalid submissions before the API ever sees them.
- **Shutdown hangs**: open keep-alive connections can block `server.close()`, so call `closeAllConnections()`. The worker must not await a long sleep after SIGTERM.
- **TypeScript**: `node:sqlite` row types are `Record<string, SQLOutputValue>`, so cast them. Keep the `import ... from './db.ts'` style, because tsconfig rewrites it.