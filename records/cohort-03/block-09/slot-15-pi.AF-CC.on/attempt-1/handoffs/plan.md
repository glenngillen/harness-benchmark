# Plan

## Approach
Keep the three existing files (`src/db.ts`, `src/server.ts`, `src/worker.ts`) plus `ui/index.html`. `db.ts` creates the schema and holds the shared row-to-JSON helpers. The server is a plain `node:http` router that does strict validation and implements idempotency with a SQLite table that has a UNIQUE key. The worker is a single loop. Each pass it writes a heartbeat, claims the oldest due queued job in a `BEGIN IMMEDIATE` transaction, and runs the steps with a ~100 ms sleep, writing progress after each one. When the worker starts, any job left `running` is put back to `queued`. The UI is one static HTML page with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `initSchema(db)` with `CREATE TABLE IF NOT EXISTS` for every table, called inside `openDatabase`. Add `rowToJob(row)` and a `Job` type.
- `src/server.ts`: routing, validation, idempotency, error shapes, health, serving the UI, SIGTERM handling.
- `src/worker.ts`: heartbeat, recovery, claim loop, step processing, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling JS.

## Steps
1. **Schema** (in `initSchema`):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INT, fail_attempts INT, attempts INT DEFAULT 0, progress INT DEFAULT 0, output TEXT, error TEXT, run_at INTEGER NOT NULL /*epoch ms when eligible*/, created_at TEXT, updated_at TEXT)`.
   - `idempotency(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`.
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)`.
   - `rowToJob` returns the exact shape from the task: `progress: {completed: progress, total: steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`.
   - Order newest first by `seq DESC`, not by timestamp, because jobs created in the same millisecond tie.
2. **Server helpers:**
   - `send(res, status, body)` as it exists today.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body by collecting chunks into a Buffer and decoding it as UTF-8.
3. **Routing:** parse `pathname`.
   - `/health`: GET only.
   - `/`: GET only, returns HTML.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/:id`, matching `^/api/jobs/([^/]+)$`: GET only.
   - Anything else is 404 `not_found`. A known path with a different method is 405 `method_not_allowed`.
   - Wrap the handler in try/catch that returns 500 `internal_error`.
4. **`POST /api/jobs` validation:** collect `fields[]` and return 400 if any. Order:
   1. Content-Type: the media type before `;`, lowercased and trimmed, must equal `application/json`. Otherwise fail with field `body`.
   2. `Idempotency-Key`: if the header is present (including empty), it must match `/^[A-Za-z0-9_-]{1,128}$/`. Otherwise add field `Idempotency-Key`.
   3. Parse JSON. On error, fail with `body` (malformed JSON).
   4. The body must be a non-null, non-array object. Otherwise fail with `body`.
   5. Each unknown key goes into `fields` under its own name.
   6. `input`: must be a string, `length` 1–1000, and `trim() !== ''`.
   7. `steps` and `failAttempts`: if present, `typeof === 'number' && Number.isInteger(v)` and within range. Otherwise add an error for that field. `null` is invalid. Apply defaults of 5 and 0.
   
   Still read and discard the body when Content-Type is bad, so the connection behaves.
5. **Idempotency:**
   - Canonical payload is `JSON.stringify({input, steps, failAttempts})`, built in that fixed key order.
   - In a `BEGIN IMMEDIATE` transaction, look up `idempotency` by key:
     - Found with the same payload: COMMIT, return 200 with that job.
     - Found with a different payload: return 409 `idempotency_conflict`.
     - Not found: insert the job (`id = crypto.randomUUID()`, status `queued`, `run_at = Date.now()`, ISO timestamps) and the idempotency row, COMMIT, return 201.
   - Without a key, just insert and return 201.
   - Use ROLLBACK on any exception.
6. **`GET /api/jobs`** returns `{jobs}` ordered by `seq DESC`. **`GET /api/jobs/:id`** returns the job or 404 `not_found`.
7. **`/health`:** read `heartbeat.at`. `worker` is `'up'` if the row exists and `Date.now() - at < 3000`, otherwise `'down'`.
8. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()`, then `db.close()` and `process.exit(0)`. Add a fallback `setTimeout(...,2000).unref()` that exits, and call `server.closeAllConnections?.()` so keep-alive connections don't hang it.
9. **Worker startup:**
   - Open the DB.
   - Recovery: `UPDATE jobs SET status='queued', progress=0, run_at=<now>, updated_at=? WHERE status='running'`. Don't touch `attempts`, because the interrupted attempt counts as started. If `attempts >= 3` for such a job, mark it `failed` with `error='transient failure'` instead, so there are never more than 3 attempts.
   - Write a heartbeat immediately: `INSERT ... ON CONFLICT(id) DO UPDATE SET at=excluded.at`.
   - Start `setInterval(heartbeat, 1000)`.
10. **Worker loop**, while not stopping:
    1. Claim the next job in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_at <= ? ORDER BY seq ASC LIMIT 1`. Then `UPDATE SET status='running', attempts=attempts+1, progress=0, updated_at=?`. COMMIT.
    2. If there's no job, `await sleep(200)` and loop.
    3. Process: `n = attempts` (after the increment). If `n <= fail_attempts`, the attempt fails before any progress:
       - If `n >= 3`: set `status='failed'`, `error='transient failure'`, `output=NULL`.
       - Otherwise: set `status='queued'`, `run_at = now + 500`, `progress=0`.
    4. Otherwise, for each step i = 1..steps: `await sleep(100)`, then `UPDATE progress=i, updated_at`. Finally set `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
    5. If `stopping` becomes true in the middle of a job, just stop. The job stays `running` and is recovered on the next start. Alternatively, finish the current step and requeue it without consuming an attempt; the simpler option of leaving it is acceptable.
    6. Await sleeps rather than busy-looping, so the heartbeat interval keeps firing.
    7. On exit: `clearInterval`, `db.close()`, `process.exit(0)`.
    8. Wrap each iteration in try/catch, logging and sleeping on errors such as SQLITE_BUSY.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form">` containing:
      - `<input data-testid="job-input" name="input">` (no `required`/`maxlength`, so the API does the validation);
      - `<input type="number" data-testid="job-steps" value="5">`;
      - `<input type="number" data-testid="job-fail-attempts" value="0">`;
      - `<button type="submit" data-testid="job-submit">`.
    - `<div data-testid="form-error" role="alert"></div>`.
    - `<ul data-testid="job-list">`.
    - On submit: `preventDefault`. Build a body with `input` as the raw value. For the numeric fields, use `Number(value)` if the value isn't blank, otherwise omit the field so the default applies. Use `type="number"` without `min`/`max`/`step`, so the browser never blocks submission.
    - POST with `Content-Type: application/json`.
    - If the response is not ok: put `error.message` plus each `field: message` from `fields` into form-error using `textContent`.
    - If it is ok: clear form-error, then refresh.
    - `refresh()` runs every 1000 ms. It fetches `/api/jobs` and rebuilds the list. Each job is an `<li data-testid="job-item" data-job-id=id>` containing:
      - `<span data-testid="job-status">`;
      - `<span data-testid="job-progress">` with `completed/total`;
      - `<span data-testid="job-result">` with the output if completed, the error if failed, otherwise empty.
      - Also show the input.
    - Always use `textContent`, never innerHTML with user data.

## Behaviours to verify
- **Build/start:** `npm run build && (PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server & npm run start:worker &)`. `/tmp/jt` gets created, and `curl localhost:3100/health` shows `worker:"up"`. Kill the worker, and within about 3 s it shows `"down"`.
- **Happy path:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"héllo","steps":3}'` returns 201 queued. Poll GET `/api/jobs/:id` and watch progress go 0→3, then `completed` with result output `HÉLLO`.
- **Retries:** `failAttempts:2` ends completed with `attempts:3`. `failAttempts:3` ends failed with `error:"transient failure"`, `attempts:3`, `result:null`.
- **Validation:** each of these returns 400 `invalid_request` with the right field:
  - `{"input":"a","steps":"3"}`;
  - `steps:0`, `steps:21`, `steps:2.5`;
  - `{"input":"   "}`;
  - an input of 1001 characters;
  - `{"input":"a","x":1}` (field `x`);
  - `[]`, `null`, `not json`;
  - no Content-Type, or `text/plain`;
  - `Idempotency-Key: bad key!`.
  
  After all of these, `GET /api/jobs` count is unchanged.
- **Idempotency:** the same key with `{"input":"a"}`, then with `{"input":"a","steps":5,"failAttempts":0}`, returns 201 then 200 with the same id. The same key with `{"input":"b"}` returns 409. Restart the server and replay: still 200 with the same id.
- **Routing:** `/nope` returns 404 `not_found`. `DELETE /api/jobs` returns 405. `GET /api/jobs/unknown` returns 404.
- **Crash recovery:** submit `steps:20`, then `kill -9` the worker in the middle of the job. Status stays `running`. Restart the worker and the job completes. Completed jobs keep their `attempts` unchanged after another restart.
- **SIGTERM:** `kill -TERM` on each process exits it promptly with code 0.
- **Repo checks:** `npm run check:smoke` and `npm run check:contract` pass.
- **UI:** open `/`, submit `steps=25`, and form-error shows `steps`. Valid submissions appear at the top and update live.

## Risks
- **Imports:** `.ts` extensions are rewritten (`rewriteRelativeImportExtensions`), so keep `./db.ts`. `node:sqlite` may need `@types/node` types; `DatabaseSync` is already used.
- **UI path:** `readFileSync(new URL('../ui/index.html', import.meta.url))` resolves from `dist/`, so keep `ui/` at the repo root.
- **Concurrent writes:** without `BEGIN IMMEDIATE`, an idempotency race or a double claim is possible. Always use explicit transactions with ROLLBACK in `finally` on error.
- **Heartbeat starvation:** never block the event loop with synchronous sleeps. Use `timers/promises`.
- **Over-strict Content-Type matching:** accept `application/json; charset=utf-8`.
- **Over-counting attempts:** don't increment `attempts` on recovery, or a crash pushes the job past 3. Recovery must also not reprocess `completed`/`failed` jobs.
- **Retry timing:** the delay must stay within 250 ms–2 s, and the poll interval of ≤200 ms keeps pickup under 1 s.
- **Shutdown hangs:** keep-alive connections can make `server.close()` hang. Use `closeAllConnections` and a forced-exit timer.
- **Numeric checks:** `typeof v === 'number'` rejects `"3"` and `true`. `Number.isInteger` rejects `NaN` and `2.5`.