# Plan

## Approach
Keep the current layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (node:http API and the UI page) and `src/worker.ts` (polling loop), plus `ui/index.html` (plain JS, no framework). Both processes call `openDatabase()`, which sets up the schema with idempotent `CREATE TABLE IF NOT EXISTS` statements. The two processes share only a `jobs` table and a `worker_heartbeat` table. The worker claims the next job with one atomic `UPDATE … RETURNING`, writes progress after every step, and schedules retries with a `run_after` timestamp. At startup it puts orphaned `running` jobs back in the queue. Idempotency uses a UNIQUE `idempotency_key` column plus a stored canonical payload, checked inside a `BEGIN IMMEDIATE` transaction.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add the schema, a `JobRow` type, `rowToJob(row)` that builds the exact API JSON shape, and `nowIso()`.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotency, health and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: form, error region, job list and polling script, all with the required `data-testid`s.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas, in one `db.exec`):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload TEXT NOT NULL)`, plus an index on `(status, run_after, seq)`.
   `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL)`, where `last_seen` is epoch ms.
   `rowToJob` returns `{id,status,input,steps,failAttempts,attempts,progress:{completed,total:steps},result: status==='completed'?{output}:null, error: status==='failed'?error:null, createdAt, updatedAt}`.
2. **Server helpers:** `send(res,status,body)` always sends `application/json; charset=utf-8`. `sendError(res,status,code,message,fields?)`. Read the body as a utf8 string, capped at about 1 MB (anything bigger is a 400 on `body`).
3. **Routing** (on `pathname`):
   - `/health` → GET.
   - `/` → GET serves the HTML. Read it from `new URL('../ui/index.html', import.meta.url)` as the current code does.
   - `/api/jobs` → GET or POST.
   - `/^\/api\/jobs\/([^/]+)$/` → GET. Run `decodeURIComponent` on the id.
   - A known path with the wrong method → 405 `method_not_allowed` with an `Allow` header. Anything else → 404 `not_found`.
   - Wrap the handler in try/catch so unexpected errors return 500 `internal_error` as JSON.
4. **Health:** `SELECT last_seen FROM worker_heartbeat WHERE id=1`. Report `worker: "up"` if `Date.now()-last_seen < 3000`.
5. **POST validation:** collect every error into a `fields` array, then return 400 `invalid_request` if the array is non-empty.
   - Content-Type: take the media type before `;`, trimmed and lowercased. It must be `application/json`. If it is missing or different, push `{field:"Content-Type"}` **and** `{field:"body"}`.
   - JSON: if `JSON.parse` fails, push `body`. If the result is not a plain object (null, an array or a primitive), push `body`.
   - Fields: each key not in {input, steps, failAttempts} → push that key name.
   - `input`: must be present, `typeof==='string'`, `length` 1–1000, and `trim()!==''`.
   - `steps` and `failAttempts`: if the key is present (`!== undefined`), the value must be `typeof==='number' && Number.isInteger(v)` and in range. `null` and `"3"` are rejected.
   - `Idempotency-Key`: if the header is present (`req.headers['idempotency-key']`), test it against `/^[A-Za-z0-9_-]{1,128}$/`. If it fails, push field `"Idempotency-Key"`. Collect this together with the body errors.
6. **Create:** build the canonical payload `JSON.stringify({input, steps, failAttempts})` with defaults applied, in a fixed key order.
   - Run `BEGIN IMMEDIATE`. If there is a key, `SELECT` by `idempotency_key`. On a hit, `COMMIT`, then return 200 with the job if the payload matches, or 409 `idempotency_conflict` if it differs.
   - Otherwise `INSERT` with `id=randomUUID()`, status `queued`, both timestamps set to `new Date().toISOString()`, and `run_after=0`. `COMMIT` and return 201. `ROLLBACK` on any error.
   - If the insert fails on the UNIQUE constraint, re-select and apply the same comparison.
7. **List and get:** `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. Get by id → the job or 404 `not_found`.
8. **Server shutdown:** on SIGTERM and SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a fallback `setTimeout(...,2000).unref()` that also exits.
9. **Worker startup:**
   - Write the heartbeat right away, then every 1000 ms with `setInterval`, using `INSERT … ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run under the same attempt number. That keeps the total at 3 or fewer and gives the same failure outcome, because a failing attempt fails before any progress. Recovery is safe because there is only one worker.
10. **Worker loop:** while not stopping, claim a job:
    `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, error=NULL, updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
    If nothing comes back, `await sleep(200)`. Otherwise process the job:
    - If `attempts <= fail_attempts`:
      - If `attempts < 3`, set `status='queued'`, `run_after=Date.now()+500` and `progress_completed=0`.
      - Otherwise set `status='failed'`, `error='transient failure'` and `result_output=NULL`.
    - Otherwise, for each step i from 1 to steps: `await sleep(100)`. If stopping, break out and requeue (see step 11). Otherwise `UPDATE progress_completed=i, updated_at`. Combine the last step with completion in one UPDATE: `status='completed'`, `progress_completed=steps`, `result_output=input.toUpperCase()`.
    - Guard every update with `WHERE id=? AND status='running'`.
11. **Worker SIGTERM:** set `stopping=true`. The loop finishes its current step sleep, puts the in-flight job back in the queue (same SQL as recovery, but for that id), clears the interval, calls `db.close()` and exits 0. Add a 3 s fallback exit.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" type="text">`
      - `<input data-testid="job-steps" type="number" value="5">`
      - `<input data-testid="job-fail-attempts" type="number" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - **Do not** use `required`, `min`, `max` or `maxlength` on these inputs.
    - Below the form: `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - Submit handler: call `preventDefault`. Build `{input: inputEl.value}`. For each numeric field, if the trimmed value is non-empty, add `Number(value)`; if `Number` gives NaN, send the raw string so the API rejects it. Send a POST with `Content-Type: application/json`.
    - If the response is not ok, show `error.message` and one line per `fields` entry as `"<field>: <message>"`. On success, clear the error region and the text input, then refresh right away.
    - Poll `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>` containing `job-status`, `job-progress` (`completed/total`), and `job-result`: the output if completed, the error if failed, empty otherwise.
    - Use `textContent` only, never innerHTML with job data. Rebuild only the list, never the form.

## Behaviours to verify
- Build and start: `npm run build`, then start both processes in either order with a temporary `DATABASE_PATH` in a missing directory. Both should log within 10 s.
- Official checks: `npm run check:smoke` and `npm run check:contract` both pass.
- Health: `curl localhost:3000/health` shows `up` while the worker runs, and `down` about 3 s after the worker is killed.
- Validation:
  - `{"input":"a","steps":"2"}` → 400 with field `steps`.
  - `{"input":"a","colour":"x"}` → field `colour`.
  - `{"steps":2}` → field `input`.
  - `"   "`, malformed JSON, `[]`, a `text/plain` Content-Type and a bad `Idempotency-Key` are all 400s.
  - None of these creates a job (compare the `GET /api/jobs` count).
- Idempotency: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` → 201 then 200 with the same id. A different input → 409. Restart the server and replay → 200 with the same id.
- Processing: `steps:5` → poll during processing and see progress climb, then `completed` with `INPUT` and `attempts 1`. `failAttempts:2` → completed with `attempts 3`. `failAttempts:3` → `failed`, error `"transient failure"`, `attempts 3`, `result null`.
- Crash recovery: submit `steps:20`, `kill -9` the worker partway through, restart it. The job completes within about 10 s, and completed jobs are not re-run (their `updatedAt` is unchanged).
- Shutdown: `kill -TERM` each process. Each exits promptly with code 0.
- UI: open `/`, submit a valid job and watch status and progress update. Submit `steps` 50 and check that `form-error` shows "steps".

## Risks
- Browser-side validation attributes (`min`/`max`/`required`) would block a bad submission, so the API rejection never appears in `form-error`. Use `novalidate` and leave those attributes off.
- Failing to collect the Idempotency-Key and Content-Type errors with the right field names. Put the field name in `fields` exactly as written above.
- Using `!body.steps`-style checks would let `0` or `null` through, or wrongly reject them. Use explicit `=== undefined` and type checks.
- Ordering by `created_at` alone makes ties ambiguous. Order by `seq DESC`.
- Recovery or SIGTERM requeueing that increments `attempts` past 3, or that re-runs completed jobs. Requeue only `status='running'`, and decrement `attempts` when doing so.
- Blocking the worker's event loop would stop heartbeats. Use only `await sleep`, never a busy-wait.
- Keep the `.ts` extensions on relative imports (the tsconfig rewrites them). The `node:sqlite` `RETURNING` result comes from `stmt.get()`.
- The server must send `application/json` for every error, including 404, 405 and 500, as well as for the health check.