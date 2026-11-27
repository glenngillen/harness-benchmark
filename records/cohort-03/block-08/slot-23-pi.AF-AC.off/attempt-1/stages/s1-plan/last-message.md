# Plan

## Approach
I'll keep the current layout: `src/db.ts` holds the schema and shared data access, `src/server.ts` serves the API and the UI, `src/worker.ts` runs the job loop, and `ui/index.html` is a single static page with inline JS. The server and worker only share the SQLite database (WAL mode, busy_timeout). The worker writes a heartbeat row every 500 ms, and `/health` reads it. Job claims, retries and recovery are all done with SQL `UPDATE` statements, so the work survives `SIGKILL`. Idempotency keys go in a table with a UNIQUE key column and are written in the same transaction as the job insert.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` for `jobs`, `idempotency_keys` and `heartbeat`. Add a `rowToJob(row)` serializer and the shared types.
- `src/server.ts`: add routing, validation, the job endpoints, idempotency, `/health` from the heartbeat, a JSON 404/405, and graceful shutdown on SIGTERM/SIGINT.
- `src/worker.ts`: add the heartbeat, startup recovery, a claim loop, step processing, retries, and graceful shutdown.
- `ui/index.html`: add the form, error region and job list with the required `data-testid`s, plus polling every 1 s.

## Steps
1. **Schema** in `db.ts`. Run it from `openDatabase` after the pragmas, in a single `db.exec`, using `IF NOT EXISTS`.
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER UNIQUE, status TEXT, input TEXT, steps INT, fail_attempts INT, attempts INT DEFAULT 0, progress INT DEFAULT 0, output TEXT NULL, error TEXT NULL, run_after INTEGER DEFAULT 0 /* epoch ms */, created_at TEXT, updated_at TEXT)`. Use `rowid`/an autoincrement `seq` for ordering, because timestamps can tie.
   - `idempotency_keys(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`.
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)`.
   - Both processes may run the schema at the same time. `IF NOT EXISTS` plus busy_timeout covers that.
   - `rowToJob` returns exactly these keys: id, status, input, steps, failAttempts, attempts, `progress:{completed,total:steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`, createdAt, updatedAt.
2. **Server routing.** Parse the pathname.
   - Known paths: `/` (GET), `/health` (GET), `/api/jobs` (GET, POST), and `/api/jobs/:id` matched by `^/api/jobs/([^/]+)$` (GET).
   - A known path with the wrong method returns 405 `method_not_allowed`. Anything else returns 404 `not_found`.
   - Every response is JSON with `content-type: application/json; charset=utf-8`, except `/`, which is HTML.
   - Wrap the handler in try/catch so an exception returns 500 `internal_error`.
3. **POST validation.** Read the full body as a string.
   - Content-Type, parsed with `split(';')[0].trim().toLowerCase()`, must be `application/json`. Otherwise reject with field `body`.
   - Check the `Idempotency-Key` header (`req.headers['idempotency-key']`) against the regex. If it fails, add field `Idempotency-Key`.
   - Run `JSON.parse` in a try. On failure, field `body`.
   - The result must be a non-null, non-array object. Otherwise field `body`.
   - Each key other than input/steps/failAttempts is reported under its own name.
   - `input`: `typeof === 'string'`, length 1–1000, and `trim() !== ''`.
   - `steps`/`failAttempts`: when present (not `undefined`), they must satisfy `typeof === 'number' && Number.isInteger(v)` and be in range. An explicit `null` is rejected.
   - Collect every error and return 400 `{error:{code:'invalid_request',message,fields}}`. Header errors and body errors can appear together.
4. **Create** inside `BEGIN IMMEDIATE … COMMIT`, with ROLLBACK on error.
   - Build the normalized payload as `JSON.stringify({input, steps, failAttempts})` in a fixed key order.
   - If there is a key, look it up. Same payload: return 200 with the existing job. Different payload: 409 `idempotency_conflict`.
   - Otherwise insert the job: id from `randomUUID()`, status `queued`, both timestamps `new Date().toISOString()`, `run_after=0`. Insert the key row if there is one, then commit and return 201.
   - `BEGIN IMMEDIATE` serializes concurrent requests that share a key, and the PRIMARY KEY is the backstop.
5. **GET list:** `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs:[...]}`. **GET one:** return the job, or 404 `not_found`.
6. **Health:** `worker = (Date.now() - heartbeat.at) < 3000 ? 'up' : 'down'`. A missing row means `down`.
7. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()`, then `db.close()`, then `process.exit(0)`. Add a 2 s fallback exit. Use `server.closeAllConnections?.()` so keep-alive connections don't block the close.
8. **Worker startup.**
   - Open the DB.
   - Upsert the heartbeat now, then every 500 ms with `setInterval`. Use `INSERT ... ON CONFLICT(id) DO UPDATE`.
   - Recovery: `UPDATE jobs SET status='queued', run_after=0, updated_at=? WHERE status='running'`. Only one worker exists, so any `running` row is orphaned.
   - Recovery does not undo the attempt. The next claim increments `attempts`, so a crashed attempt counts toward the 3.
   - If a recovered job already has `attempts>=3`, mark it `failed` with "transient failure" only if it would fail again (`attempts+1 <= failAttempts` and `attempts>=3`). Simpler alternative: at claim time, if `attempts>=3`, fail it immediately.
   - Recommended: re-run recovered jobs with no attempt cap check beyond the normal rule, i.e. a claim where `attempts` is already 3 marks the job `failed`. That handles the edge case.
9. **Worker loop**, while not stopping.
   - In a transaction, select `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`.
   - If there is none, sleep 200 ms.
   - Otherwise set `status='running', attempts=attempts+1, progress=0, updated_at`. Let `n` = the new attempts value.
   - If `n <= fail_attempts`, the attempt fails before any progress:
     - `n < 3`: set `status='queued'`, `run_after=now+500`, `updated_at`.
     - `n >= 3`: set `status='failed'`, `error='transient failure'`, `output=NULL`.
   - Otherwise, for each step i from 1 to steps: `await sleep(100)`, then `UPDATE progress=i, updated_at`.
   - When steps are done: `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
   - Guard every update with `WHERE id=? AND status='running'`.
10. **Worker shutdown.** SIGTERM sets `stopping`.
    - The loop checks `stopping` between steps. If it is set mid-job, put the job back to `queued` (progress 0, without touching attempts), or leave it `running` and let recovery handle it.
    - Then clear the interval, close the DB, and exit 0 within about 1 s. Add a fallback timer with `process.exit(0)` after 3 s.
11. **UI.**
    - The form (`job-form`) has `job-input` (input type text), `job-steps` (type number, value 5), `job-fail-attempts` (type number, value 0), and `job-submit`.
    - Add `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - On submit: preventDefault. Build the body as `{input, steps: Number(v), failAttempts: Number(v)}`, but if a numeric field is empty, send its raw string instead of `NaN`/`0` so the API rejects it. Also add `novalidate` on the form so the browser doesn't block bad values; the API must validate.
    - POST with `content-type: application/json`.
    - If the response is not ok, set form-error textContent to `message` plus each `field: message`. If it is ok, clear form-error and refresh.
    - Poll `GET /api/jobs` every 1000 ms. Render `li[data-testid=job-item][data-job-id]` with spans `job-status`, `job-progress` (`c/t`), and `job-result` (output, or error, or empty).
    - Use `textContent` (never innerHTML with user input) and keep newest-first order.

## Behaviours to verify
- **Build and start:** `npm run build && PORT=3100 DATABASE_PATH=/tmp/t/jobs.db npm run start:server` and `start:worker` (in either order). Check that `curl /health` shows `worker:"up"`. Kill the worker, wait about 3 s, and check it shows `down`.
- **Contract checks:** `npm run check:smoke` and `npm run check:contract` (read `checks/cli.ts` for the env/port it expects).
- **Validation:** curl these cases:
  - no content-type;
  - `text/plain`;
  - `{bad`;
  - `[]`;
  - `{"input":"  "}`;
  - `{"input":"a","steps":"3"}`;
  - `steps:1.5`, `steps:21`, `failAttempts:6`;
  - an extra field `x`;
  - the header `Idempotency-Key: bad key!`.

  Every case should return 400 with the matching `fields[].field`, and the job count should not change.
- **Idempotency:**
  - Send key K with `{"input":"a"}`: 201.
  - Repeat with `{"input":"a","steps":5,"failAttempts":0}`: 200 with the same id.
  - Send `{"input":"b"}` with key K: 409.
  - Restart the server and repeat: still 200 or 409.
- **Progress:** submit `steps:20` and poll `GET /api/jobs/:id`. `progress.completed` should increase, and the run should take about 2 s.
- **Retries:**
  - `failAttempts:2` should end `completed` with `attempts:3`.
  - `failAttempts:3` should end `failed`, `error:"transient failure"`, `attempts:3`, `result:null`.
- **Crash recovery:** start a `steps:20` job, `kill -9` the worker mid-run, then restart it. The job should finish. Completed jobs should stay untouched (`attempts` unchanged).
- **404/405:** `GET /nope` returns 404 JSON. `DELETE /api/jobs` and `POST /health` return 405. `GET /api/jobs/unknown` returns 404 `not_found`.
- **UI:** open `/`, submit a job, and watch status and progress update. Submit an empty input: form-error should show "input".

## Risks
- **Import extensions:** imports must stay as `./db.ts` (tsconfig rewrites them). The UI path `../ui/index.html` is relative to `dist/`, and that already works.
- **`node:sqlite` binding:** pass `null`, not `undefined`, as a parameter. Use `db.prepare(...).get/all/run`. Rows come back as null-prototype objects, so map them explicitly.
- **Heartbeat during long steps:** don't block the heartbeat. Use `setInterval` with async sleeps, never synchronous busy loops.
- **Attempt counting:** check whether the attempt fails before the first step's progress update, and count attempts at claim time. That keeps `attempts` exactly 3 on final failure.
- **Ordering:** order by `seq`/rowid, not `created_at`. Jobs created in the same millisecond would tie and break newest-first and oldest-first.
- **Content-Type check:** use a prefix match (with charset). The checks send `application/json` exactly.
- **Worker exit:** an open interval or pending timer keeps the worker alive after SIGTERM. Clear the interval and call `process.exit(0)` explicitly.
- **Lock errors:** wrap write transactions in try/catch and retry the loop on `SQLITE_BUSY`, rather than crashing.