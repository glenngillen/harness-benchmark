# Plan

## Approach
I keep the existing layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (`node:http` API and the UI) and `src/worker.ts` (polling loop), plus a single static `ui/index.html` with inline JS. Both processes open the same SQLite file through `openDatabase()`. It keeps the busy_timeout/WAL pragmas and adds an idempotent `CREATE TABLE IF NOT EXISTS` migration. The `jobs` table holds all job state, including a `run_after` timestamp for retry delays and a `UNIQUE` idempotency key. The worker claims jobs inside `BEGIN IMMEDIATE` transactions, writes progress after each step and updates a heartbeat row, which `/health` reads. Everything uses only Node 22 built-ins (`node:sqlite` `DatabaseSync`, `node:http`, `node:crypto` `randomUUID`).

## Files
- `src/db.ts`: keep `openDatabase`. Add `migrate(db)` (called inside `openDatabase`), the `JobRow` type, `rowToJob(row)` (builds the API JSON shape), `nowIso()`, and helpers to read and write the heartbeat.
- `src/server.ts`: rewrite. Adds routing, body reading, validation, idempotent create, list/get, health, UI serving and SIGTERM shutdown.
- `src/worker.ts`: rewrite. Adds startup recovery, heartbeat interval, the claim/process loop, retries and SIGTERM shutdown.
- `src/validate.ts` (new, optional): a pure `validateSubmission(contentType, rawBody, idemKey)` that returns `{ok, payload}` or `{fields}`.
- `ui/index.html`: form, error region, job list and polling script.

## Steps
1. **Schema** in `migrate` (run `CREATE TABLE IF NOT EXISTS` for each):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE)`
   - an index on `(status, run_after, seq)`
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL)`

   `rowToJob` returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Use `?` positional params. Don't bind booleans or `undefined`; use `null`.
2. **Server routing**: parse the pathname with `new URL`.
   - `/health`: GET only.
   - `/`: GET only, serves the HTML. Keep the `../ui/index.html` URL relative to `import.meta.url`, which resolves correctly from `dist/`.
   - `/api/jobs`: GET or POST.
   - `/api/jobs/:id` (regex `^/api/jobs/([^/]+)$`, then decodeURIComponent): GET.
   - A known path with another method returns `405 method_not_allowed`. Anything else returns `404 not_found`.
   - All JSON goes through `send()`, which sets `application/json; charset=utf-8`.
   - Wrap the handler in try/catch so errors return `500 {error:{code:'internal_error',...}}`.
3. **Body reading**: collect chunks up to about 1 MB, then decode as UTF-8.
4. **Validation**: collect a `fields` array.
   - Content-Type missing or not matching `/^application\/json\b/i`: add `body` ("Content-Type must be application/json").
   - Otherwise `JSON.parse` in try/catch. On failure, add `body` (malformed JSON). If the result is not a plain object (null, an array or a primitive), add `body`.
   - If the body is an object, add every unknown key as its own field.
   - `input` must be a string with `length` from 1 to 1000 and `input.trim() !== ''`. Store it unmodified.
   - `steps`: if absent, default 5. Otherwise it must be `typeof === 'number' && Number.isInteger && 1..20`. Reject `null` and `"3"`.
   - `failAttempts`: same rule with range 0..5 and default 0.
   - `Idempotency-Key` header: if present (even empty), it must match `/^[A-Za-z0-9_-]{1,128}$/`, otherwise add field `"Idempotency-Key"`. Check it even when the body is invalid.
   - If `fields` is not empty, return `400 {error:{code:'invalid_request', message:'Invalid request', fields}}`.
5. **Create** in one transaction (`BEGIN IMMEDIATE` … `COMMIT`, with ROLLBACK in a catch):
   - If there is a key, `SELECT` by `idempotency_key`. If found, compare `input`, `steps` and `fail_attempts` with the payload after defaults. Equal returns `200` with the job. Different returns `409 idempotency_conflict`.
   - Otherwise `INSERT` with `id=randomUUID()`, `status='queued'`, `attempts=0`, `progress=0`, `created_at=updated_at=nowIso()`, `run_after=0`, and the key or NULL. Return `201`.
   - Backstop: on a UNIQUE constraint error, re-select and apply the same comparison.
6. **List and get**: `SELECT * FROM jobs ORDER BY seq DESC` returns `{jobs}`. Get by `id` returns the job or `404 not_found`.
7. **Health**: `worker = Date.now() - heartbeat.last_seen < 3000 ? 'up' : 'down'`. Use `'down'` if there is no row.
8. **Server SIGTERM/SIGINT**: call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a 2 s `setTimeout(...).unref()` force-exit as a fallback.
9. **Worker startup**:
   - Open the DB and write the heartbeat right away (`INSERT ... ON CONFLICT(id) DO UPDATE SET last_seen=?`).
   - Run `setInterval(heartbeat, 500)`.
   - Recovery: `UPDATE jobs SET status='queued', progress_completed=0, run_after=0, updated_at=? WHERE status='running'` (there is only one worker process).
   - Log "worker started".
10. **Worker loop**: `while (!stopping)`:
    - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`. If a row is found, `UPDATE SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`, then COMMIT.
    - If nothing was claimed, `await sleep(200)`.
    - Otherwise, with `n` = the new attempts count:
      - If `n <= fail_attempts`: sleep about 100 ms, then fail the attempt. If `n >= 3`, set `status='failed', error='transient failure', result_output=NULL`. Otherwise set `status='queued', run_after=Date.now()+500, progress_completed=0`. Always update `updated_at`.
      - Otherwise, for each step i=1..steps: if `stopping`, break out. Otherwise `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`.
      - After the last step, `UPDATE status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Guard every update with `WHERE id=? AND status='running'`.
11. **Worker SIGTERM/SIGINT**: set `stopping=true`. If a job is mid-run, the loop requeues it (`status='queued', progress_completed=0, run_after=0`). Leave `attempts` as is, since that attempt was started. Then `clearInterval`, set `heartbeat last_seen=0` so health shows down at once, `db.close()` and exit 0. The response to the signal must finish well within a few seconds: steps are 100 ms and the idle sleep is 200 ms.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing `<input data-testid="job-input">`, `<input data-testid="job-steps" type="number" value="5">`, `<input data-testid="job-fail-attempts" type="number" value="0">` and `<button data-testid="job-submit" type="submit">`.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - Do not use HTML `min`/`max`/`required`, which could stop out-of-range values from reaching the API.
    - **Submit**: call `preventDefault`. Build the body as `{input: value}`. For each numeric field: if the trimmed value is `''`, omit it. Else if `Number.isFinite(Number(v))`, send `Number(v)`. Else send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, set `form-error` to the message plus a line per field: `${field}: ${message}`.
    - On success, clear `form-error`, clear the input and refresh at once.
    - **Polling**: `setInterval(refresh, 1000)` calls `GET /api/jobs`. Render each job as `<li data-testid="job-item" data-job-id=id>` with `<span data-testid="job-status">`, `<span data-testid="job-progress">${completed}/${total}</span>` and `<span data-testid="job-result">` (the output if completed, the error if failed, else empty).
    - Use `textContent` only and keep the API order (newest first). Reuse `li` elements keyed by id if convenient; never re-render the form.
13. Run `npm run build`. It must compile under strict TS with `verbatimModuleSyntax` (use `import type`) and keep `.ts` import extensions, as the scaffold does.

## Behaviours to verify
- **Build and start**: run `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/jt/x/jobs.db npm run start:server` and `npm run start:worker` in either order. The nested directory should be created.
- **Fixed checks**: `npm run check:smoke` and `npm run check:contract` (read `checks/cli.ts` for the env/args they expect).
- **Health**: `curl /health` returns `up` while the worker runs, and `down` within about 3 s of killing it (at once after SIGTERM).
- **Create and complete**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"héllo","steps":3}'` returns 201 queued. Poll GET `/api/jobs/:id` to see progress 1/3, 2/3, then completed with output `HÉLLO`.
- **Validation**: each of these returns 400 with the right `fields`:
  - `{"input":"a","steps":"3"}` gives `steps`
  - `{"input":"   "}` gives `input`
  - `{"input":"a","x":1}` gives `x`
  - `[1]`, `not json`, or no Content-Type gives `body`
  - `steps:1.5`, `steps:21`, `failAttempts:6`
  - `Idempotency-Key: bad key!`
  - an input of 1001 characters

  `GET /api/jobs` should show no new jobs.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 201 then 200 with the same id. The same key with `{"input":"b"}` returns 409. Restart the server and replay: still 200, same id.
- **Retries**: `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with `error "transient failure"`, `result null` and attempts 3. Watch `queued` show up between attempts.
- **Routing**: `/nope` returns 404 `not_found`. `DELETE /api/jobs` returns 405. `/api/jobs/unknown` returns 404.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, then restart. The job should complete within a few seconds. Completed jobs must not change (`updatedAt` stays the same).
- **SIGKILL both processes**: restart both; all jobs are still listed.
- **UI**: open `/`, submit a job, and watch status and progress update without a reload. Submit `steps=50` and `form-error` should mention `steps`.

## Risks
- **Content-Type check**: the comparison must allow `application/json; charset=utf-8`. Use a regex, not equality.
- **Type checks**: `typeof x === 'number'` is required so `"3"` is rejected. `Number.isInteger` rejects NaN and 1.5. JSON can't produce NaN, but `null` must be rejected rather than defaulted.
- **Field names**: unknown fields must each be listed by name. Use `"body"` only for whole-body problems.
- **Browser validation**: HTML number constraints or `required` would stop submissions before they reach the API, and `form-error` would never show. Use `novalidate` and no min/max.
- **Heartbeat timing**: use epoch ms, not ISO strings, to avoid timezone and parse issues. Write it on an interval independent of job processing; the sync DB calls are short, so the timer still fires.
- **SQLITE_BUSY**: run migrations in both processes; busy_timeout covers it. Always ROLLBACK on error inside transactions so the connection isn't left mid-transaction.
- **Ordering**: sort by `seq`, not `createdAt`, since timestamps can tie at ms resolution.
- **Lost jobs on shutdown**: the worker must not exit leaving a job `running` forever. Startup recovery covers SIGKILL, and the SIGTERM path requeues.
- **Hanging shutdown**: open keep-alive connections can keep the server running after SIGTERM. Use `closeAllConnections()` plus the force-exit timer.
- **XSS in the UI**: build the DOM with `textContent`, never `inn
[truncated]