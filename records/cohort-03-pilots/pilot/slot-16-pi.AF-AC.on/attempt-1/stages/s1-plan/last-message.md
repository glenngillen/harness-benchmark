# Plan

## Approach
Keep the existing layout: `src/db.ts` holds the shared schema and data-access helpers, `src/server.ts` is a `node:http` API plus the static UI, and `src/worker.ts` is a polling loop. Both processes share the SQLite database through `node:sqlite` `DatabaseSync` (WAL mode and busy_timeout, which db.ts already sets). All coordination goes through the database. Job rows store the state, a `heartbeat` table carries worker liveness, `next_run_at` handles retry delays, and a UNIQUE `idempotency_key` column with the stored normalized payload handles idempotency. `ui/index.html` is a single file of plain JS that polls `GET /api/jobs` every second and updates the DOM using the required `data-testid`s.

## Files
- `src/db.ts`: keep `openDatabase`. After the pragmas, run the schema with `CREATE TABLE IF NOT EXISTS`. Add a row→JSON mapper `toJob(row)` and shared types.
- `src/server.ts`: rewrite. Add routing, JSON helpers, body reading, validation, idempotency, health and graceful shutdown.
- `src/worker.ts`: rewrite. Add the heartbeat, crash recovery, the claim/process loop, retries and graceful shutdown.
- `ui/index.html`: add the form, the error region, the job list and the polling script.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT,
     next_run_at INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_pick ON jobs(status, next_run_at, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(name TEXT PRIMARY KEY, ts INTEGER NOT NULL);
   ```
   `toJob(row)` returns exactly: `{id, status, input, steps, failAttempts, attempts, progress:{completed,total:steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Make the mapper force `result` and `error` to null in every other case.
2. **Server helpers**:
   - `send(res,status,body)` sets `application/json; charset=utf-8`.
   - `sendError(res,status,code,message,fields?)`.
   - Wrap the whole handler in try/catch and return 500 `internal_error` on failure.
3. **Routing**, using the pathname from `new URL`:
   - `/` allows GET (serves the HTML).
   - `/health` allows GET.
   - `/api/jobs` allows GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` allows GET.
   - A known path with the wrong method returns 405 `method_not_allowed`. Everything else returns 404 `not_found`.
4. **GET /health**: `SELECT ts FROM heartbeat WHERE name='worker'`. Return `worker: 'up'` when `Date.now()-ts < 3000`.
5. **GET /api/jobs**: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs: rows.map(toJob)}`. Order by `seq` rather than created_at, because several jobs can share a millisecond. **GET /api/jobs/:id** looks up by id, or returns 404 `not_found`.
6. **POST /api/jobs validation**. Collect `fields[]` and don't stop at the first error, except where noted:
   - Read the body as a Buffer and cap it at about 1 MB. A larger body is a body error.
   - Content-Type: take the part before `;`, trim it, lowercase it, and require `application/json`. If it's missing or wrong, add field `"body"` with the message "Content-Type must be application/json".
   - `Idempotency-Key` header: if present and failing `/^[A-Za-z0-9_-]{1,128}$/`, add field `"Idempotency-Key"`.
   - If Content-Type is OK, `JSON.parse` inside try. Malformed JSON adds field `"body"`. A parsed value that is not a plain object (null, an array or a primitive) also adds field `"body"`.
   - If the body is an object:
     - For each key not in {input, steps, failAttempts}, add that key as a field ("unknown field").
     - `input` must be `typeof string`, have `length` 1–1000 and satisfy `trim() !== ''`. Store it untrimmed.
     - `steps` and `failAttempts`: `undefined` takes the default. Otherwise require `typeof number && Number.isInteger && in range`. A numeric string such as `"3"` is rejected.
   - If there are any field errors, return 400 `invalid_request` with `fields`.
7. **Create and idempotency**:
   - Build the normalized payload with a fixed key order: `JSON.stringify({input, steps, failAttempts})`.
   - Wrap the following in `BEGIN IMMEDIATE` … `COMMIT`, with ROLLBACK on error:
     - If there is a key, `SELECT` by `idempotency_key`. If a row exists and its payload matches, return 200 `toJob(row)`. If it exists and differs, return 409 `idempotency_conflict`.
     - Otherwise INSERT with id `crypto.randomUUID()`, status `queued`, attempts 0, progress 0, `next_run_at = 0`, and created/updated set to `new Date().toISOString()`. Return 201.
   - The UNIQUE column guarantees one job per key even across restarts. If a UNIQUE constraint error is caught anyway, re-select and apply the same comparison.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()` (the UI keep-alive polling would otherwise block close), then `db.close()` and `process.exit(0)`. Log once listening on `PORT` (default 3000).
9. **Worker startup**:
   - Open the DB.
   - Write the heartbeat right away: `INSERT … ON CONFLICT(name) DO UPDATE SET ts=excluded.ts`. Then use `setInterval(beat, 500)`.
   - Recover crashed jobs: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, next_run_at=0, updated_at=? WHERE status='running'`. The interrupted attempt doesn't count, so a job interrupted on attempt 3 never shows 4 attempts. A crash can only happen after the first step has passed, so the failAttempts semantics are kept.
10. **Worker loop**: `while(!stopping)`:
    - Claim with `SELECT * FROM jobs WHERE status='queued' AND next_run_at<=? ORDER BY seq ASC LIMIT 1`. Then run `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`, and only proceed if `changes===1`.
    - If nothing was claimed, `sleep(200)`.
    - Process with n = the new attempts value:
      - First `await sleep(100)`. If `n <= fail_attempts`, the attempt fails before any progress:
        - if `n < 3`: `status='queued', next_run_at=now+500, progress_completed=0`;
        - otherwise: `status='failed', error='transient failure', result_output=NULL`.
      - Otherwise, for each step i = 1..steps: `sleep(100)` (except the first, which already slept), then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps.
      - When done: `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Every status UPDATE also sets `updated_at`.
11. **Worker shutdown**: SIGTERM/SIGINT sets `stopping`. If a job is mid-run, the loop breaks out between steps and requeues it with the same SQL as recovery. Then clear the interval, set heartbeat ts=0, call `db.close()` and `process.exit(0)`.
12. **UI** (`ui/index.html`):
    - Form `data-testid="job-form"` with `novalidate`, containing:
      - `<input data-testid="job-input">`;
      - `<input type="number" data-testid="job-steps" value="5">` with no min/max;
      - `<input type="number" data-testid="job-fail-attempts" value="0">`;
      - `<button type="submit" data-testid="job-submit">`.
    - `<div data-testid="form-error" role="alert"></div>`.
    - `<ul data-testid="job-list">`.
    - On submit (preventDefault), build the body as `{input}`. For each numeric field: an empty value is omitted; if `Number(v)` is finite, send the number (so 2.5 or 25 still reach the API and get rejected); otherwise send the raw string. POST it with `Content-Type: application/json`.
    - On a non-2xx response, fill form-error with `error.message` plus one line per field, `field: message`.
    - On success, clear form-error and refresh the list right away.
    - Poll `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>` with spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (the output when completed, the error when failed, otherwise ''). Keep the API's newest-first order. Use `textContent` only, never innerHTML with user data.

## Behaviours to verify
- Build and start: `npm run build && (npm run start:worker &) && npm run start:server`. Both log within a few seconds. Also start them in the reverse order.
- Health: `curl localhost:3000/health` shows worker `up`. Kill the worker and within about 3 s it shows `down`.
- Create and complete: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}' localhost:3000/api/jobs` returns 201 queued. Poll GET by id and watch progress go 1/3, 2/3, then completed with `HI` and attempts 1.
- Retries: `failAttempts:1` → completed with attempts 2. `failAttempts:2` → completed with attempts 3. `failAttempts:3` → failed, `error:"transient failure"`, attempts 3, result null.
- Validation: each of these returns 400 with the right field:
  - `steps:"2"` → steps;
  - `failAttempts:7` → failAttempts;
  - `colour` → colour;
  - missing input → input;
  - `input:"   "` → input;
  - `steps:2.5` → steps;
  - `[]` → body;
  - `{bad` → body;
  - no or text/plain content-type → body;
  - a bad key such as `Idempotency-Key: a b` → Idempotency-Key.

  The job count is unchanged afterwards.
- Idempotency: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 201 then 200 with the same id. A different input returns 409. Restart the server and replay: still 200 with the same id.
- Routes: `DELETE /api/jobs` → 405; `GET /nope` → 404 not_found; `GET /api/jobs/xyz` → 404.
- Crash recovery: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job completes, and attempts don't exceed what's expected.
- Durability: SIGKILL both processes, restart, and all jobs are still listed.
- SIGTERM: `kill -TERM` makes each process exit with code 0 promptly, even with the UI page open.
- Running checks: `npm run check:smoke` and `npm run check:contract` both pass.
- UI: open `/`, submit a job and watch status and progress update with no reload. Submit steps=25 and form-error shows "steps".

## Risks
- **Ordering:** sort by `seq`, not the timestamp, or newest-first breaks when two jobs land in the same millisecond.
- **Numeric strings:** don't coerce numbers. `"3"` must be rejected, while JSON `3.0` parses to 3 and is accepted.
- **Null fields:** the job shape must always include `result` and `error` as null. Don't leave stray values from an earlier failed attempt.
- **Shutdown:** without `closeAllConnections()`, keep-alive UI polling hangs `server.close()`. Call `process.exit` explicitly.
- **Imports:** keep the `.ts` relative import extensions (`rewriteRelativeImportExtensions` is on), and don't use TS features type-stripping can't handle, such as enums or namespaces.
- **Database writes:** use short, synchronous transactions and don't hold `BEGIN IMMEDIATE` across an `await`. busy_timeout 5000 is already set.
- **Recovery:** without decrementing attempts on recovery, a crash on attempt 3 could produce `attempts: 4` or skip completion. Requeue with next_run_at=0 so the job restarts well within 10 s.
- **Heartbeat:** write it from `setInterval`, not only between jobs, so it stays fresh during a 20-step job. The step `await`s let the timer run.
- **form-error:** it must be empty on load and after a successful submit, and the messages must include the field names exactly as the API reports them.