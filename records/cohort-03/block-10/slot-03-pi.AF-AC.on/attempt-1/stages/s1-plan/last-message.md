# Plan

## Approach
Keep the current layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (node:http API that also serves the UI) and `src/worker.ts` (polling worker loop), all on `node:sqlite` `DatabaseSync` with the existing WAL and busy_timeout setup. A single `jobs` table holds all job state, including the idempotency key (UNIQUE) and the canonical payload. A `worker_heartbeat` row tells the server whether the worker is alive. The worker claims a job atomically with `UPDATE … RETURNING`, writes progress after every step, and schedules retries through a `run_after` timestamp. When it starts, it puts any `running` jobs back in the queue to recover from crashes. `ui/index.html` is a self-contained page with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` for both tables, a `JobRow` type, `rowToJob(row)` (maps to the exact API JSON shape) and `nowIso()`.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotent create, list/get, health, UI, error helpers and SIGTERM shutdown.
- `src/worker.ts`: rewrite with heartbeat, recovery, claim loop, step processing, failure and retry handling, and SIGTERM shutdown.
- `ui/index.html`: form, error region, job list and polling script, with all the required `data-testid` attributes.

## Steps
1. **Schema** (run in `openDatabase` after the pragmas, so either process can start first):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL);
   ```
   `rowToJob` builds `{id,status,input,steps,failAttempts,attempts,progress:{completed,total:steps},result: status==='completed'? {output}: null, error: status==='failed'? error : null, createdAt, updatedAt}`. Order by `seq`, not by timestamps, because timestamps can tie.
2. **Server helpers**: `send(res,status,body)` always sets `application/json; charset=utf-8`. `sendError(res,status,code,message,fields?)`.
3. **Routing** (on `pathname`):
   - `/`: GET serves the HTML (text/html).
   - `/health`: GET only.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/:id`: GET only. Match with regex `^/api/jobs/([^/]+)$` and `decodeURIComponent` inside try/catch.
   - Known path with another method: 405 `method_not_allowed`. Anything else: 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **Health**: `SELECT beat_at FROM worker_heartbeat WHERE id=1`. `worker` is `up` if `Date.now()-beat_at < 3000`, otherwise `down`.
5. **POST validation**: collect every problem into a `fields` array, then return 400 `invalid_request` if it is non-empty.
   - Idempotency-Key: if the header is present (even as an empty string) and does not match `^[A-Za-z0-9_-]{1,128}$`, add field `"Idempotency-Key"`.
   - Content-Type: take the media type before `;`, trim and lowercase it. Anything other than `application/json` (including missing) adds field `body`. Return immediately in that case, without parsing.
   - Body: read it fully, with a 1 MB cap (over the cap is a 400 with field `body`). Then `JSON.parse` inside try/catch; failure adds field `body`. A parsed value that is null, an array or not an object also adds `body`.
   - Unknown keys: one field entry per key outside `input`, `steps`, `failAttempts`.
   - `input`: must be present, `typeof === 'string'`, length from 1 to 1000, and `trim() !== ''`.
   - `steps` and `failAttempts`: if present, `typeof === 'number' && Number.isInteger(v)` and within range. If absent, use the defaults 5 and 0. Note that `null` counts as present and is invalid.
6. **Create**: build the canonical payload `JSON.stringify({input, steps, failAttempts})` in that fixed key order. Inside `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on error):
   - With a key, `SELECT * FROM jobs WHERE idempotency_key=?`. If a row exists and its payload is equal, return 200 with that job. If the payload differs, return 409 `idempotency_conflict`.
   - Otherwise INSERT with id `crypto.randomUUID()`, status `queued`, attempts 0, `run_after=0` and timestamps `new Date().toISOString()`, then return 201.
   - The UNIQUE constraint backs this up across restarts and races.
7. **List and get**: `SELECT * FROM jobs ORDER BY seq DESC` returns `{jobs}`. Get by id returns 404 `not_found` if missing.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()`, then `server.closeAllConnections()` and `db.close()`, then `process.exit(0)`. Add a 3 s fallback `setTimeout(...).unref()` that forces the exit.
9. **Worker startup**:
   - Open the db.
   - Write the heartbeat immediately: `INSERT … ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`. Repeat it with `setInterval(…, 1000)`.
   - Recover crashed jobs: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is redone, so `attempts` never goes past 3. There is only one worker, so this is safe.
10. **Worker loop** (while not stopping):
    - Claim: `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
    - If nothing was claimed, `await sleep(200)` and loop again.
    - Otherwise call `process(job)`.
11. **process(job)**: let `n = job.attempts` (already incremented).
    - **Failure** (`n <= fail_attempts`): `await sleep(100)`, then decide. If `n < 3`, set status `queued`, `run_after=Date.now()+500`, `progress_completed=0`. Otherwise set status `failed`, `error='transient failure'`, `result_output=NULL`. Update `updated_at` in both cases.
    - **Success**: for i in 1..steps, `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps; if it is set, put the job back with `status='queued', attempts=attempts-1, progress_completed=0` and return.
    - **Completion**: set status `completed`, `result_output=input.toUpperCase()`, `progress_completed=steps`. Use a `WHERE id=? AND status='running'` guard on every update.
12. **Worker shutdown**: SIGTERM/SIGINT sets `stopping=true`. When the loop ends, clear the interval, `DELETE FROM worker_heartbeat`, `db.close()` and `process.exit(0)`. Add a 3 s fallback timer that forces the exit.
13. **UI** (`ui/index.html`):
    - Form: `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - `novalidate` is needed so out-of-range values reach the API.
    - Below the form: `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - **Submit**: `preventDefault`. Build the body as `{input}`. For each numeric field: if the value is empty, omit it. Otherwise send `Number(v)` when it is finite, else the raw string, so the API rejects it.
    - POST with `Content-Type: application/json`. On a non-2xx response, put `error.message` plus one line per field, `"<field>: <message>"`, into form-error. On success, clear form-error and refresh the list right away.
    - **Polling**: `setInterval(refresh, 1000)` plus one call at load.
    - **Rendering**: one `<li data-testid="job-item" data-job-id=id>` per job, newest first, in API order. Each item contains spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result.output`, or `error`, or empty), plus the input text.
    - Use `textContent` only, never innerHTML with user data.
14. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`. Fix anything that fails.

## Behaviours to verify
- Start in either order, with defaults: delete `data/` and run `npm run build && npm run start:worker`, then start the server. `data/jobs.db` should be created.
- Health: `curl localhost:3000/health` should show `worker: up` while the worker runs, and `down` within 3 s of killing it.
- Create, list and get: POST `{"input":"hi","steps":2}` returns 201 with queued status, `attempts` 0 and `progress` `{0,2}`. GET list shows it first. GET with an unknown id returns 404 `not_found`.
- Validation: each of these returns 400 with the listed field, and the job count stays the same:
  - `steps:"2"` (steps)
  - `failAttempts:7` (failAttempts)
  - an extra `colour` field (colour)
  - missing input (input)
  - `"   "` input (input)
  - malformed JSON (body)
  - `[]` (body)
  - `text/plain` Content-Type (body)
  - Idempotency-Key `bad key!` (Idempotency-Key)
- Routes: `DELETE /api/jobs` returns 405 and `/nope` returns 404, both as JSON.
- Idempotency: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 201 then 200 with the same id. The same key with a different input returns 409. Restart the server and replay: 200 with the same id.
- Progress: a job with `steps:10` shows `progress.completed` rising when polled.
- Retries: `failAttempts:2` completes with `attempts` 3 and the uppercased output. `failAttempts:3` ends `failed`, with `attempts` 3, `error` `"transient failure"` and `result` null. Exactly one job exists in each case.
- Crash recovery: start a job with `steps:20`, `kill -9` the worker mid-run and restart it. The job completes and `attempts` is at most 3. Completed jobs are not touched.
- SIGTERM: `kill -TERM` on each process exits it with code 0 in under 5 s.
- UI: open `/` and submit `steps=50`. form-error shows `steps`. A valid submission appears at the top and updates status and progress live.

## Risks
- **Retry timing:** if `run_after` is ignored or the delay is too long, retries break the timing rule. Keep it at 500 ms, and keep the idle poll at 200 ms so pickup stays under 1 s.
- **SQLITE_BUSY:** two processes write to the same db. Keep busy_timeout, keep transactions short, and use `BEGIN IMMEDIATE` for create. Never hold a transaction across an `await`.
- **Numeric strings and nulls:** do not coerce `"3"`, and remember that `null` and booleans are invalid. JSON `1.0` parses to 1, which is fine.
- **Content-Type:** the check is on the media type only; `application/json; charset=utf-8` must be accepted.
- **Process exit:** the open db and the heartbeat interval can keep a process alive. Exit explicitly after cleanup.
- **UI path:** the HTML is read through `new URL('../ui/index.html', import.meta.url)`, which resolves from `dist/`. Keep the file at `ui/index.html`.
- **Imports:** keep `.ts` extensions in relative imports (`rewriteRelativeImportExtensions` handles them). With `verbatimModuleSyntax`, type-only imports must use `import type`.
- **Browser validation:** without `novalidate`, browser number validation blocks out-of-range submissions, and form-error never shows the API error.
- **Response shape:** return `result`/`error` exactly as null outside their terminal states, and `progress.total` equal to `steps`.