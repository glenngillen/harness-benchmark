# Plan

## Approach
Keep the three existing source files and add shared modules. `src/db.ts` creates the schema and holds the helpers both processes use. `src/server.ts` is a plain `node:http` router with strict validation and idempotency enforced by a UNIQUE column in SQLite. `src/worker.ts` is a polling loop that writes a heartbeat, claims the oldest due queued job in a `BEGIN IMMEDIATE` transaction, and writes progress after each step. Retries are rows in `queued` with a `run_after` timestamp. Crash recovery means that when the worker starts, it puts any `running` jobs back to `queued`, because only one worker exists. `ui/index.html` is one static page with inline JS that polls `GET /api/jobs` every 1 s.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). After the pragmas, add idempotent schema creation (`CREATE TABLE IF NOT EXISTS`). Add `rowToJob(row)` and a shared `Job` type.
- `src/validate.ts` (new): `validateSubmission(contentType, rawBody, idemKey)`. It returns either `{ok:true, value:{input,steps,failAttempts}}` or `{ok:false, fields:[...]}`.
- `src/server.ts`: router, handlers, health check, SIGTERM shutdown.
- `src/worker.ts`: heartbeat, recovery, claim/process loop, SIGTERM shutdown.
- `ui/index.html`: the form, the alert region, the job list, and polling JS.

## Steps
1. **Schema in db.ts**
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, idem_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0)`. `run_after` is epoch ms.
   - `seq` is an ordering key: `Date.now()*1000 + counter`. Alternatively, use `INTEGER PRIMARY KEY AUTOINCREMENT rowid` as `seq` with `id` as `crypto.randomUUID()`. Prefer the AUTOINCREMENT version: `seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL)`.
   - Index on `(status, run_after, seq)`.
   - `rowToJob` builds the exact JSON shape: `progress:{completed:progress,total:steps}`, `result: status==='completed' ? {output} : null`, and `error: status==='failed' ? error : null`.
2. **validate.ts.** Collect every offending field before returning.
   - Content-Type: parse the media type with `split(';')[0].trim().toLowerCase()`. It must equal `application/json`. Otherwise add field `body` ("Content-Type must be application/json") and return right away.
   - Run `JSON.parse` in a try block. On failure, add field `body`. If the result is not a plain object (`null`, an array, or a primitive), add field `body`.
   - Unknown keys: one entry per key, using the key name as the field.
   - `input`: must be present, `typeof === 'string'`, have `length` from 1 to 1000, and satisfy `trim().length > 0`. Store it untrimmed.
   - `steps` / `failAttempts`: if present (`!== undefined`), require `typeof === 'number' && Number.isInteger(v)` and the range check. Otherwise apply the default. An explicit `null` is invalid.
   - Idempotency-Key: if the header is present (even empty), it must match `/^[A-Za-z0-9_-]{1,128}$/`; otherwise add field `Idempotency-Key`. If Node gives an array, treat it as invalid.
3. **server.ts router.** Parse `pathname`.
   - `/health`: GET only.
   - `/`: GET only. Serve the HTML from the existing `readFileSync`; `../ui/index.html` relative to `dist/` works.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/:id`: matches `^/api/jobs/([^/]+)$`, GET only.
   - A known path with the wrong method returns `405 method_not_allowed`. Anything else returns `404 not_found`. Wrap handlers in try/catch and return `500 internal_error`. Every JSON response goes through `send`.
4. **POST handler.**
   - Read the whole body as a string. Validate it. On failure, return 400 `{error:{code:'invalid_request',message:'Invalid request',fields}}`.
   - With a key: in a transaction, `SELECT` by `idem_key`. If a row exists, compare `input`, `steps` and `fail_attempts` with the normalized payload: equal returns 200 with the job, different returns `409 idempotency_conflict`. If no row exists, INSERT and return 201.
   - Also catch a UNIQUE constraint error on INSERT and re-select (belt and braces).
   - Use `db.exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK`. `node:sqlite` is synchronous, so within one process there's no interleaving.
   - INSERT uses `status='queued'`, `attempts=0`, `progress=0`, and `created_at=updated_at=new Date().toISOString()`.
5. **GET list and GET by id.**
   - List: `SELECT * FROM jobs ORDER BY seq DESC`, mapped with `rowToJob`, returned as `{jobs}`.
   - By id: return the job, or `404 not_found`.
6. **Health.** `SELECT beat_at FROM worker_heartbeat WHERE id=1`. Report `up` if `Date.now()-beat_at < 3000`.
7. **Server shutdown.** On SIGTERM/SIGINT, call `server.close()`, `server.closeAllConnections()` and `db.close()`, then `process.exit(0)`, with a fallback timer.
8. **Worker startup.**
   - Open the db, ensure the schema, and write the heartbeat immediately.
   - Start `setInterval(beat, 500)`. The heartbeat is an UPSERT: `INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`.
   - Recovery: `UPDATE jobs SET status='queued', progress=0, run_after=0, updated_at=? WHERE status='running'`. The `attempts` count is kept. That interrupted attempt counts, so when it is re-picked, `attempts` increments.
   - If `attempts` is already ≥ 3 for a recovered running job, mark it `failed` with `"transient failure"`, but only if it was a failing attempt. Simpler: just requeue it. Then when claiming, if `attempts >= 3`, the next attempt would be a 4th. To avoid that, on recovery set `failed` when `attempts >= 3 && attempts <= fail_attempts`; otherwise requeue. Acceptable simplification: let a recovered job have a fresh attempt even if this makes `attempts` reach 4 for jobs that weren't going to fail. Recommended rule: requeue, and on claim cap at 3, so a job with `attempts>=3` that is claimed runs without incrementing past 3 (`attempts = MIN(attempts+1, 3)`).
9. **Worker loop.** Run `while (!stopping)`.
   - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq ASC LIMIT 1`. If found, `UPDATE status='running', attempts=MIN(attempts+1,3), progress=0, updated_at=now`, then COMMIT.
   - If there is no job, sleep 200 ms.
   - Process: let `n` be the new `attempts`.
     - If `n <= fail_attempts`, the attempt fails. Sleep about 100 ms (the first step), then:
       - if `n < 3`: `UPDATE status='queued', run_after=now+500, progress=0, updated_at`;
       - otherwise: `status='failed', error='transient failure', output=NULL`.
     - Otherwise, for each step `i` from 1 to `steps`: `await sleep(100)`, check `stopping`, then `UPDATE progress=i, updated_at`.
     - After the last step: `UPDATE status='completed', output=input.toUpperCase(), progress=steps`.
   - Guard every update with `WHERE id=? AND status='running'`.
10. **Worker shutdown.** On SIGTERM, set `stopping`. If a step is in flight, abandon the job by leaving it `running`; the next startup's recovery requeues it. Alternatively, requeue it immediately on stop: `status='queued', progress=0`. Then clear the interval, close the db, and `process.exit(0)` within about 1 s.
11. **UI (`ui/index.html`).**
    - `<form data-testid="job-form">` with:
      - `input[data-testid=job-input]` (text);
      - `input[type=number][data-testid=job-steps]` with value 5;
      - `input[type=number][data-testid=job-fail-attempts]` with value 0;
      - `button[type=submit][data-testid=job-submit]`.
    - `<div data-testid="form-error" role="alert"></div>`, and `<ul data-testid="job-list">`.
    - Don't add HTML `min`, `max` or `required` attributes. Use `novalidate` on the form, so the browser never blocks a submission the evaluator expects the API to reject.
    - On submit, `preventDefault`. Build the body: `input` is the raw value. For numeric fields, send `Number(value)` if `value.trim() !== ''`, and omit the field if empty. A non-numeric string becomes `NaN`, which serializes as `null`, which the API rejects; fine.
    - POST with `Content-Type: application/json`.
      - If the response is not ok: set the form-error text to `error.message` plus each `field: message` line.
      - If ok: clear the form-error and refresh right away.
    - Poll with `setInterval(refresh, 1000)`. Render each `li[data-testid=job-item][data-job-id]` with spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`), plus the input text.
    - Set text with `textContent` only (no innerHTML from data).
12. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and start:** `npm run build`, then start both processes with `PORT=3100 DATABASE_PATH=/tmp/t/jobs.db` in each start order. `curl /health` shows `worker:"up"`. Kill the worker, and within about 3 s it shows `"down"`.
- **Validation:** curl with each case below and check for 400 and the listed fields: `{"input":"a","steps":"3"}`, `{"input":"  "}`, `{"x":1,"input":"a"}`, `[1]`, `{bad`, a `text/plain` content-type, `steps:1.5`, `steps:21`, `failAttempts:6`, and header `Idempotency-Key: a b`. Then check that `GET /api/jobs` count is unchanged.
- **Idempotency:** post the same key twice, with and without defaults, and get 201 then 200 with the same id. A different input gives 409. Restart the server and repeat: still 200 with the same id.
- **Processing:** with `steps:10`, poll `GET /api/jobs/:id` every 100 ms and watch progress climb. The final state is `completed` with uppercase output and progress 10/10.
- **Retries:** `failAttempts:2` ends `completed` with `attempts:3`. `failAttempts:3` ends `failed`, `error:"transient failure"`, `attempts:3`, `result:null`.
- **Crash recovery:** start a job with 20 steps, `kill -9` the worker mid-run, restart it, and check that the job completes. Already completed jobs are unchanged (same `updatedAt`).
- **Routing:** `DELETE /api/jobs` gives 405, `GET /nope` gives 404 `not_found`, and `GET /api/jobs/unknown` gives 404.
- **UI:** open `/` and submit an empty input. The alert shows `input`. Submit a valid job and watch status and progress update with no reload.
- **Shutdown:** `kill -TERM` exits each process promptly with code 0.

## Risks
- **Lock contention:** using `BEGIN` instead of `BEGIN IMMEDIATE` causes SQLITE_BUSY lock upgrades. Keep busy_timeout, and keep transactions short and synchronous: no `await` inside a transaction.
- **ESM path:** `import.meta.url` resolves in `dist/`; keep the `../ui/index.html` path. Imports must use `.ts` extensions, which tsconfig rewrites, as the existing code does.
- **Field naming:** don't trim the stored input. Validation errors must use `fields[].field` names exactly: `input`, `steps`, `failAttempts`, `body`, `Idempotency-Key`.
- **Ordering:** sort by the autoincrement `seq`, not by `createdAt`; jobs created in the same millisecond would tie.
- **Retry timing:** use `run_after` instead of sleeping inside the worker while holding the job. The job must show `queued` during the wait, and the delay must fall within 250 ms to 2 s (use 500 ms).
- **Attempt cap:** don't let `attempts` exceed 3 after crash recovery. Use the `MIN(attempts+1,3)` cap, and still apply the `n <= fail_attempts` rule.
- **`node:sqlite` values:** it returns INTEGER columns as numbers by default. Make sure booleans or bigints don't leak into JSON.
- **Health freshness:** the heartbeat interval must be well under 3 s. Write the first beat immediately at startup.