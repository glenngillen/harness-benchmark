# Plan

## Approach
Keep the current layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` is a `node:http` API that also serves `ui/index.html`, and `src/worker.ts` is a polling loop. Both processes open the same SQLite file through `openDatabase()`. Its existing busy_timeout/WAL setup stays, and it also runs `CREATE TABLE IF NOT EXISTS`, so either process can start first. All state changes that read and then write (idempotent insert, job claim) run inside `BEGIN IMMEDIATE` transactions. The worker writes a heartbeat row every 1 s, and `/health` compares it with the current time. The UI is one static HTML file with inline JS. It polls `GET /api/jobs` every 1 s and updates keyed DOM nodes.

## Files
- `src/db.ts`: keep `openDatabase`. Add the schema, a `Job` row type, `rowToJob()` (builds the API JSON shape), and small query helpers used by both processes.
- `src/server.ts`: routing, body reading, validation, idempotency, error shapes, 404/405, `/health` with heartbeat, SIGTERM shutdown.
- `src/worker.ts`: crash recovery at startup, heartbeat, claim loop, step processing, retries, SIGTERM shutdown.
- `ui/index.html`: form, error region, job list, polling script (the server reads it from `../ui/index.html` relative to `dist/`, which already works).

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, idempotency_key TEXT UNIQUE, payload TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, an index on `(status, run_after, seq)`, and `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), ts INTEGER NOT NULL)`.
   - `rowToJob`: `progress: {completed: progress_completed, total: steps}`, `result: status==='completed' ? {output: result_output} : null`, `error: status==='failed' ? error : null`.
   - Timestamps come from `new Date().toISOString()`. Ids come from `crypto.randomUUID()`.
2. **Server helpers**:
   - `send(res, status, body)`: always `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body as a utf8 string, with a size cap of about 1 MB. Over the cap, return 400 with field `body`.
3. **Routing**: match the pathname exactly.
   - `/health` allows GET. `/` allows GET (HTML). `/api/jobs` allows GET and POST. `^/api/jobs/([^/]+)$` allows GET; decode the id with `decodeURIComponent` inside try/catch.
   - A known path with another method returns 405 `method_not_allowed`. Anything else returns 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` on failure.
4. **Validation for POST /api/jobs**: collect *all* field errors into `fields`.
   - Content-Type: take the media type before `;`, trim and lowercase it. It must equal `application/json`. If it doesn't, add field `body` and skip parsing.
   - `JSON.parse` fails: field `body`. Parsed value is not a plain object (null, array, primitive): field `body`.
   - Each unknown key is added as its own field.
   - `input`: must be a string with `1 <= length <= 1000` and `trim().length > 0`. Store it unchanged.
   - `steps` and `failAttempts`: if `undefined`, use the default. Otherwise require `typeof === 'number' && Number.isInteger(v)` and the range check. Strings like `"3"` are rejected.
   - The `Idempotency-Key` header (`req.headers['idempotency-key']`), if present, must match `^[A-Za-z0-9_-]{1,128}$`. If it doesn't, add field `Idempotency-Key`. Validate the key even when the body is invalid, and report everything together. Any error returns 400 `invalid_request` and creates no job.
5. **Create / idempotency**:
   - Build a canonical payload: `JSON.stringify({input, steps, failAttempts})`, after defaults, with the keys always in that order.
   - In `BEGIN IMMEDIATE`: if there is a key, `SELECT` by `idempotency_key`. If a row exists and its payload is equal, COMMIT and return 200 with that job. If the payload differs, return 409 `idempotency_conflict`.
   - Otherwise INSERT with status `queued`, attempts 0, and `run_after = 0`, then return 201.
   - Use try/catch with ROLLBACK. The UNIQUE constraint is the backstop that makes the guarantee hold across restarts.
6. **List / get**:
   - List: `SELECT * FROM jobs ORDER BY seq DESC`, returning `{jobs:[...]}`. Order by `seq`, not `created_at`, because two jobs can share a millisecond.
   - Get by id: 404 `not_found` if missing.
7. **Health**: read `heartbeat.ts`. Return `worker: 'up'` if the row exists and `Date.now() - ts < 3000`.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a fallback `setTimeout(...).unref()` that exits.
9. **Worker startup**:
   - Write the heartbeat immediately, then every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is not counted, so the retry rules stay consistent and the job can never exceed 3 attempts.
   - Completed and failed jobs are never touched.
10. **Worker loop**: `while (!stopping)`.
    - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq LIMIT 1`, then `UPDATE ... SET status='running', attempts=attempts+1, progress_completed=0, error=NULL, result_output=NULL, updated_at=now`. COMMIT.
    - If nothing was claimed, `sleep(200)` and loop again.
    - Process the claimed job with `n = attempts`:
      - If `n <= fail_attempts`, the attempt fails before any progress. If `n >= 3`, set `status='failed', error='transient failure', result_output=NULL`. Otherwise set `status='queued', run_after=Date.now()+500, progress_completed=0`.
      - Otherwise, for `i` in `1..steps`: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. After the loop: `status='completed', result_output=input.toUpperCase()`.
    - Every UPDATE after the claim adds `WHERE id=? AND status='running'`.
    - On SIGTERM, finish the current job (at most about 2 s), then exit the loop. Then `clearInterval`, delete the heartbeat row (so health reports down quickly), `db.close()`, and `process.exit(0)`.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing `input[type=text][data-testid=job-input]`, `input[type=number][data-testid=job-steps] value=5`, `input[type=number][data-testid=job-fail-attempts] value=0`, and `button[type=submit][data-testid=job-submit]`.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list"></ul>`.
    - On submit: `preventDefault`. Build the body with `input` as a raw string. For each numeric field: empty means omit it; `Number(v)` if finite, otherwise send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`. If the response is not ok, set form-error textContent to `message` plus a `field: message` line for each entry in `fields`. If it is ok, clear form-error and refresh immediately.
    - Poll `/api/jobs` every 1000 ms. Keep a map from id to `<li data-testid="job-item" data-job-id>` containing spans `job-status`, `job-progress` (`${completed}/${total}`), and `job-result` (output if completed, error if failed, otherwise `''`).
    - Reorder or prepend so the list matches the API order (newest first). Use `textContent` only, never innerHTML with user data.
    - Do not re-render the form while polling.

## Behaviours to verify
- Build and checks: run `npm run build`, then `npm run check:smoke` and `npm run check:contract` (read `checks/cli.ts` for how it launches the processes and which env vars it uses).
- Startup order: start the server only and `curl /health`; it should report `worker:"down"`. Start the worker; within about 1 s it reports `up`. Kill the worker; within 3 s it reports `down`.
- Create: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}' localhost:3000/api/jobs` returns 201 queued. Poll `GET /api/jobs/:id` and watch progress go 0→3, then `completed` with output `HI`.
- Validation:
  - `{"input":"x","steps":"2"}` → field `steps`.
  - `failAttempts: 7` → `failAttempts`.
  - `colour` → `colour`.
  - missing input → `input`.
  - `"   "` → `input`.
  - `[]`, `nul`, text/plain → `body`.
  - Bad key `a b` → `Idempotency-Key`.
  - The job count is unchanged after all of these.
- Idempotency: same key and payload `{"input":"a"}`, then `{"input":"a","steps":5,"failAttempts":0}` → the second returns 200 with the same id. Same key with a different input → 409. Restart the server and replay the first request → 200 with the same id.
- Retries: `failAttempts:1, steps:1` → completed, attempts 2. `failAttempts:2` → attempts 3, completed. `failAttempts:3` → failed, `error:"transient failure"`, attempts 3, result null. Exactly one job is listed each time.
- Crash recovery: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job completes within a few seconds. Completed jobs keep their `updatedAt`.
- 404/405: `GET /nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `POST /health` → 405.
- UI: open `/` and submit valid and invalid jobs. The list updates live, and form-error shows field names on rejection.
- SIGTERM: `kill -TERM` each process; it exits with code 0 quickly.

## Risks
- **Imports**: keep the `./db.ts` import style (tsconfig has `rewriteRelativeImportExtensions`), and don't use TS-only syntax that strip-types can't handle (enums, parameter properties), in case the checks import it.
- **SQLite locking**: the server and worker write at the same time, so keep transactions short, always ROLLBACK in `catch`, and never `await` inside a transaction. `node:sqlite` is synchronous, so this is easy as long as you never sleep between BEGIN and COMMIT.
- **Retry backoff**: blocking the loop with the sleep would stall other jobs. Store `run_after` instead, and query with `run_after <= now`.
- **Default values**: `typeof null === 'object'` and `steps: null` must be rejected. Only `undefined` gets the default.
- **Numeric validation**: `Number.isInteger(2.0)` is true. That is fine, because JSON can't tell `2.0` from `2`.
- **Content-Type**: use a strict media-type comparison; `application/json; charset=utf-8` must be accepted.
- **Error responses**: every error path, including 404/405/500, must return JSON with the `{error:{code,message}}` shape.
- **Job order**: use `seq`, not timestamps, so the ordering is deterministic.
- **Recovery accounting**: a recovered job must not go over 3 attempts or skip its fail logic. The decrement in step 9 handles this. Never reset `attempts` on normal retries.
- **UI polling**: don't rebuild the whole list with innerHTML, because that can drop the evaluator's element references. Update nodes in place. Keep form-error truly empty (`''`) on success.