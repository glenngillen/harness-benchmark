# Plan

## Approach
Keep the existing three-file layout (`src/db.ts`, `src/server.ts`, `src/worker.ts`) and the single page `ui/index.html`. `db.ts` owns the schema and all SQL helpers, and both processes use it. The server validates requests, handles idempotency inside a SQLite transaction, and maps rows to the job JSON shape. The worker sends a heartbeat on a timer and runs a polling loop. Each loop claims the oldest queued job that is due, runs its steps with `await sleep(100)`, and writes progress after each step. Retries use a `run_after` timestamp column. Jobs left in `running` after a crash are reset to `queued` when the worker starts. The UI is plain HTML/JS: it calls `/api/jobs` every second and updates elements in place by `data-job-id`.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for `jobs`, `idempotency_keys` and `heartbeat`. Add `rowToJob(row)` and the shared query helpers. Both processes call schema creation, since either may start first.
- `src/server.ts`: routing, body reading, validation, idempotency, error responses, `/health` from the heartbeat, serving `/`, and SIGTERM shutdown.
- `src/worker.ts`: heartbeat interval, crash recovery at startup, claim/process loop, retries, and SIGTERM shutdown.
- `ui/index.html`: the form, the `form-error` alert region, the job list, and the polling script.

## Steps
1. **Schema** (in `db.ts`, `initSchema(db)` called from `openDatabase`):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
   - `idempotency_keys(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`
   - `heartbeat(name TEXT PRIMARY KEY, at INTEGER NOT NULL)`
   - `rowToJob` returns exactly these keys: `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
2. **Server helpers:** `send(res, status, body)` always uses `application/json; charset=utf-8`. Add `sendError(res, status, code, message, fields?)`. Wrap the handler in try/catch and return `500 internal_error` if anything throws.
3. **Routing** (on `pathname`):
   - `/` GET serves the HTML.
   - `/health` GET returns `{status:'ok', worker}`. `worker` is `'up'` if `Date.now() - heartbeat.at < 3000`, otherwise `'down'`. A missing row means `'down'`.
   - `/api/jobs`: GET lists jobs with `ORDER BY seq DESC`. POST creates a job.
   - `/^\/api\/jobs\/([^/]+)$/` GET returns the job or `404 not_found`.
   - A known path with any other method returns `405 method_not_allowed`. Everything else returns `404 not_found`.
4. **Reading the POST body:** read the full body as a utf8 string. Cap it at about 1 MB; past that, return 400 `invalid_request` with field `body`.
5. **POST validation.** Collect `fields` from all of these, then return one 400 if any exist:
   - **Content-Type:** take the header, split on `;`, trim and lowercase it. It must equal `application/json`. If it is missing or different, push `{field:'body', message:'Content-Type must be application/json'}` and skip parsing.
   - **Idempotency-Key:** if the header is present (including empty string) and does not match `/^[A-Za-z0-9_-]{1,128}$/`, push field `Idempotency-Key`.
   - **Parse:** run `JSON.parse` in a try block. On failure push `body` "malformed JSON". If the result is not a plain object (null, an array or a primitive), push `body`.
   - **Object checks:**
     - Each unknown key gets its own entry, with the key name as the field.
     - `input` must be `typeof string`, `length` 1–1000, and `trim() !== ''`. A missing `input` counts as an error.
     - `steps` and `failAttempts`: if the key is absent, apply the default. If present, the value must be `typeof number`, `Number.isInteger`, and within range. Reject `null` and `"3"`.
6. **Idempotency and insert:**
   - Canonical payload is `JSON.stringify({input, steps, failAttempts})`, in that fixed key order.
   - Run `BEGIN IMMEDIATE` … `COMMIT`, with rollback on error.
   - If a key was given, look it up. If found with an equal payload, return `200` with the stored job. If found with a different payload, return `409 idempotency_conflict`.
   - Otherwise insert the job: `id = crypto.randomUUID()`, `status='queued'`, `attempts=0`, `progress=0`, `run_after=0`, and the same ISO time for both `created_at` and `updated_at`. Then insert the key row and return `201`.
7. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()`, then `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Listen on `PORT` (default 3000).
8. **Worker startup:**
   - Open the DB (this creates the schema).
   - Run recovery: `UPDATE jobs SET status='queued', progress=0, run_after=0, updated_at=? WHERE status='running'`.
   - Write the heartbeat right away (`INSERT … ON CONFLICT(name) DO UPDATE SET at=excluded.at`), then every 500 ms with `setInterval`. The step loop is async with sleeps, so the timer fires reliably.
9. **Worker loop**, while not stopping:
   - Claim: in one statement, `UPDATE jobs SET status='running', attempts=MIN(attempts+1,3), progress=0, updated_at=? WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
   - If nothing was claimed, `await sleep(200)` and loop again.
   - The `MIN(...,3)` cap matters. If a job crashed during attempt 3, that attempt had already passed its failure check (failures happen before any progress), so re-running with n=3 gives the correct outcome and `attempts` never goes above 3.
   - Process the claimed job with `n = attempts`:
     - **Failure branch** (`n <= fail_attempts`): wait one step (~100 ms) and fail without progress. If `n < 3`, set `status='queued'`, `run_after = now + 500`, `updated_at`. Otherwise set `status='failed'`, `error='transient failure'`, `output=NULL`.
     - **Normal branch:** for `i = 1..steps`, `await sleep(100)`, then `UPDATE progress=i, updated_at`. Stop early if `stopping`. After the last step, set `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
   - Every update includes `WHERE id=? AND status='running'` as a guard.
10. **Worker shutdown:** on SIGTERM/SIGINT, set `stopping=true`. The loop leaves after the current step and leaves the job `running`; recovery at the next startup re-queues it. Then clear the interval, delete the heartbeat row (or set `at=0`), call `db.close()` and `process.exit(0)`. Also add a fallback `setTimeout(() => process.exit(0), 2000).unref()`.
11. **UI** (`ui/index.html`):
    - The form uses `data-testid="job-form"` and `novalidate`. Fields:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`, with no min/max so the API does the validating
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - Add `<div data-testid="form-error" role="alert"></div>`, empty by default, and `<ul data-testid="job-list">`.
    - **On submit:** `preventDefault`. Build the body as `{input}`. For each numeric field, add `Number(value)` if the field is not blank; a blank field is omitted so the default applies. `fetch` POST with `content-type: application/json`.
    - **If the response is not ok:** fill form-error with `error.message` plus one line per `fields` entry, `"<field>: <message>"`, using textContent. On success, clear form-error, clear the input, and refresh the list right away.
    - **Polling:** `setInterval(refresh, 1000)` plus a first load on page start. `refresh` GETs `/api/jobs`. For each job, find or create `<li data-testid="job-item" data-job-id>` containing spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`). Keep the list in API order (newest first) by re-appending the items in order.

## Behaviours to verify
- **Build and start:** `npm run build`, then start the server and worker in either order with a temp `DATABASE_PATH=/tmp/x/jobs.db` (the directory should get created). `curl /health` should show `worker: up`. Stop the worker; within about 3 s it should show `down`.
- **Validation:** each of these should return 400 `invalid_request` with the right `fields`: no content-type, `text/plain`, `{bad`, `[]`, `"x"`, `{"input":"   "}`, `{"input":"a","steps":"3"}`, `{"steps":0}` (two fields: input and steps), `{"input":"a","x":1}`, a 1001-character input, and the header `Idempotency-Key: a b`. Confirm with `GET /api/jobs` that no job was created.
- **Idempotency:** `{"input":"a"}` with key K returns 201. `{"input":"a","steps":5,"failAttempts":0}` with K returns 200 and the same id. `{"input":"b"}` with K returns 409. Restart the server and repeat: still 200 with the same id.
- **Processing:** a job with `steps:5` shows `progress.completed` going up while polled every 100 ms, ends `completed` with uppercased output and `5/5`, and gets picked up within 1 s.
- **Retries:** `failAttempts:2` ends `completed` with `attempts:3`. `failAttempts:3` and `failAttempts:5` end `failed` with `attempts:3`, `error:"transient failure"` and `result:null`. The total job count does not change.
- **Crash recovery:** submit a job with `steps:20`, `kill -9` the worker mid-run, restart it, and confirm the job completes. `kill -9` the server too and confirm all jobs are still listed. Completed jobs keep their `updatedAt` after restarts.
- **SIGTERM:** both processes exit within about 1 s with code 0.
- **Checks:** run `npm run check:smoke` and `npm run check:contract`.
- **UI:** open `/`, submit a job, and watch status and progress update. Submit `steps` 50 and confirm form-error mentions `steps`.

## Risks
- **Wrong error code for 404 vs 405:** `/api/jobs/:id` with POST must return 405, not 404. An unknown `/api/foo` must return 404.
- **Content-Type with parameters:** `application/json; charset=utf-8` must be accepted, so split on `;` before comparing.
- **Defaults vs explicit nulls:** apply a default only when the key is absent (`!('steps' in body)`). An explicit `null` is an error.
- **Attempts going above 3 after a crash:** use the `MIN(attempts+1,3)` claim and the recovery that resets `running` to `queued`. Never leave a job stuck in `running`.
- **Lock errors when both processes start together:** keep busy_timeout before WAL, as the existing code does. Keep transactions short and fully synchronous, with no `await` inside a transaction.
- **ESM import paths:** keep imports as `./db.ts`. tsconfig's `rewriteRelativeImportExtensions` turns them into `.js`. The UI path `new URL('../ui/index.html', import.meta.url)` resolves from `dist/`, which works.
- **Duplicate jobs from idempotent POSTs:** do the key lookup and insert inside one `BEGIN IMMEDIATE` transaction. The key table's PRIMARY KEY is the final guard against duplicates.
- **UI re-renders breaking the evaluator:** update existing nodes instead of replacing all of them, so held references keep working. Use textContent, never innerHTML, for user input.
- **SIGTERM not exiting:** the worker's sleep loop and the heartbeat interval can keep the process alive. Clear the interval and call `process.exit` explicitly.