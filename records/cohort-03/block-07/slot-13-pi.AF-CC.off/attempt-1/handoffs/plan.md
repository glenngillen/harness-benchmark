# Plan

## Approach
Keep the current layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (node:http API plus the static UI), `src/worker.ts` (polling loop), and `ui/index.html` (one page with inline JS). The server and worker never talk to each other. All state lives in SQLite through `node:sqlite` `DatabaseSync`, with WAL mode and busy_timeout (both already in `db.ts`). The worker claims a job with one atomic `UPDATE ... RETURNING`, writes progress after every step, schedules retries with a `run_after` timestamp, and writes a heartbeat row about every 500 ms. A job left `running` after a crash is reclaimed when the worker starts. Keep the relative imports ending in `.ts`: tsconfig sets `rewriteRelativeImportExtensions`, so the compiled output imports `.js`.

## Files
- src/db.ts: keep `openDatabase`. Add `migrate(db)` (CREATE TABLE IF NOT EXISTS), the `JobRow` type, `rowToJob(row)` to build the API JSON, and `nowIso()`. Call `migrate` inside `openDatabase` so whichever process starts first creates the schema.
- src/server.ts: routing, body reading, validation, idempotency, health, and SIGTERM handling.
- src/worker.ts: claim, process and retry loop, heartbeat, crash recovery, and SIGTERM handling.
- ui/index.html: the form, job list and polling script, with every required `data-testid`.

## Steps
1. Schema in `migrate`:
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, idempotency_key TEXT UNIQUE, run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)`. Store `run_after` as epoch ms.
   - `CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq)`.
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)`.
   - Set `seq` from a monotonic counter: use `(SELECT COALESCE(MAX(seq),0)+1 FROM jobs)` inside the INSERT. Order "newest first" as `ORDER BY seq DESC` and "oldest first" as `seq ASC`. Do not rely on timestamps for ordering, because they can tie.
   - Generate ids with `crypto.randomUUID()`.
2. `rowToJob` returns exactly `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
3. Server helpers:
   - `send(res, status, body)` with `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body as a utf8 string.
4. Routing. Known paths are `/`, `/health`, `/api/jobs` and `/api/jobs/:id`, where `:id` matches `^/api/jobs/([^/]+)$` and is decoded with `decodeURIComponent` inside a try/catch.
   - Allowed methods: GET for `/`, `/health` and `/api/jobs/:id`; GET and POST for `/api/jobs`.
   - A known path with another method returns 405 `method_not_allowed` and includes an `Allow` header.
   - Anything else returns 404 `not_found`.
   - Wrap the handler in try/catch and answer 500 `internal_error` on failure.
5. `GET /health`: `SELECT at FROM heartbeat WHERE id=1`. Report `worker: 'up'` if `Date.now() - at < 3000`, otherwise `'down'`.
6. POST validation. Collect `fields[]` and do not stop at the first error.
   - If the content-type is missing, or its media type before `;` (lowercased and trimmed) is not `application/json`, add field `body`.
   - Otherwise run `JSON.parse` in a try/catch. A parse failure adds `body`. A value that is not a plain object (null, an array or a primitive) adds `body`.
   - For an object, add each key outside {input, steps, failAttempts} under its own name.
   - `input`: must be present, `typeof === 'string'`, `1 <= length <= 1000` and `trim().length > 0`.
   - `steps` and `failAttempts`: when present (`!== undefined`), require `typeof === 'number' && Number.isInteger(v)` and the range check. Explicit `null` is invalid. Apply the defaults 5 and 0.
   - The `Idempotency-Key` header (`req.headers['idempotency-key']`) is checked separately. If present and it fails `^[A-Za-z0-9_-]{1,128}$`, add field `Idempotency-Key`.
   - If there are any fields, return 400 `invalid_request` with a message and the `fields` list.
7. Idempotency, done inside `BEGIN IMMEDIATE ... COMMIT` (with ROLLBACK on error):
   - If there is a key, `SELECT` by `idempotency_key`.
   - If a row exists and its input, steps and fail_attempts all equal the normalized payload, return 200 with that job. If any differ, return 409 `idempotency_conflict`.
   - Otherwise INSERT a queued job (attempts 0, progress 0, run_after 0) and return 201.
   - The UNIQUE constraint backs this up, and it holds across restarts because it lives in the DB.
8. `GET /api/jobs` returns `{jobs: rows ORDER BY seq DESC}`. `GET /api/jobs/:id` returns the job or 404 `not_found`.
9. `GET /` serves the `ui/index.html` read at startup, using the existing `new URL('../ui/index.html', import.meta.url)`, which works from `dist/`.
10. Server SIGTERM/SIGINT: `server.close()`, `db.close()`, `process.exit(0)`. Add a 2 s forced-exit timer with `.unref()`. Before closing, call `server.closeAllConnections()`, because keep-alive sockets would otherwise hang the close.
11. Worker startup:
    - Open the DB.
    - Write the heartbeat immediately with `INSERT ... ON CONFLICT(id) DO UPDATE SET at=excluded.at`, then repeat every 500 ms with `setInterval`.
    - Recovery: `UPDATE jobs SET status='queued', progress=0, run_after=0, updated_at=? WHERE status='running'`. Only one worker exists, so any `running` row is orphaned. The interrupted attempt has already been counted in `attempts`.
12. Worker loop, `while (!stopping)`:
    - Claim with `UPDATE jobs SET status='running', attempts=attempts+1, progress=0, updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
    - If nothing was claimed, `await sleep(200)` and loop.
    - Otherwise process the claimed job (step 13).
13. Processing one attempt:
    - Let `n = attempts` (already incremented). If `n <= fail_attempts`, the attempt fails immediately: if `n >= 3`, set status `failed`, error `'transient failure'`, output NULL. Otherwise set status `queued`, progress 0, `run_after = Date.now() + 500`.
    - Otherwise run `for i in 1..steps`: `await sleep(100)`, then `UPDATE progress=i, updated_at`.
    - If `stopping` becomes true mid-job, return without changing anything. The row stays `running` and is recovered on the next start, which is acceptable.
    - After the last step, set status `completed`, `output = input.toUpperCase()`, progress = steps.
    - Every UPDATE sets `updated_at`.
14. Worker SIGTERM: set `stopping = true`. After the loop exits (at most about 200 ms later, or after the current step), clear the interval, `db.close()` and `process.exit(0)`. Also add a forced-exit timer.
15. UI (`ui/index.html`):
    - `<form data-testid="job-form">` containing `<input data-testid="job-input">`, `<input type="number" data-testid="job-steps" value="5">`, `<input type="number" data-testid="job-fail-attempts" value="0">` and `<button type="submit" data-testid="job-submit">`.
    - `<div data-testid="form-error" role="alert"></div>`.
    - `<ul data-testid="job-list">`.
    - On submit, call `preventDefault`. Build the body as `{input: inputEl.value, steps: Number(stepsEl.value), failAttempts: Number(failEl.value)}`. Leave out a numeric field when it is blank, so the default applies rather than sending NaN, which `JSON.stringify` turns into null.
    - POST with `Content-Type: application/json`. If the response is not OK, write `error.message` plus each `field: message` into form-error. On success, clear form-error and refresh the list.
    - Poll `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>` containing `<span data-testid="job-status">`, `<span data-testid="job-progress">${completed}/${total}</span>` and `<span data-testid="job-result">` (the output if completed, the error if failed, otherwise empty).
    - Set text with `textContent` only, never innerHTML with user input. Render the list in API order, which is newest first.

## Behaviours to verify
- Build and start: `npm run build`, then run `npm run start:worker` and `npm run start:server` in either order. Both should log within a few seconds.
- Health: `curl localhost:3000/health` reports worker up while the worker runs, and down within 3 s after you kill it.
- Create, get and list: POST `{"input":"hi","steps":2}` returns 201 with a queued job (attempts 0, progress 0/2). `GET /api/jobs` lists it first. `GET /api/jobs/nope` returns 404 `not_found`.
- Validation: each of these returns 400 with the named field: `steps:"2"` → steps; `failAttempts:7` → failAttempts; an extra `colour` key → colour; missing input → input; malformed JSON, a `[]` body, a missing or `text/plain` content-type → body; a bad key header such as `a b` → Idempotency-Key. Afterwards the job count is unchanged.
- Processing: poll a 5-step job. `progress.completed` climbs over about 0.5 s and the job ends completed with output `HI` and attempts 1.
- Retries: `failAttempts:1, steps:1` completes with attempts 2. `failAttempts:2` completes with attempts 3. `failAttempts:3` ends failed with error `"transient failure"`, attempts 3 and result null. There is exactly one job per submission.
- Idempotency: two posts with the same key and payload (`{input,steps:1}`, then the same with `failAttempts:0`) return 201 then 200 with the same id. A different input under that key returns 409. The replay still returns 200 after a server restart.
- Crash recovery: start a 20-step job, `kill -9` the worker mid-run and restart it. The job completes within a few seconds. Completed jobs keep their attempts count after the restart.
- Wrong method: `DELETE /api/jobs` returns 405. `GET /foo` returns 404.
- UI: open `/`, submit a job and watch status and progress update. Submit an empty input and form-error shows "input".
- Run `npm run check:smoke` and `npm run check:contract`.

## Risks
- Two processes opening the DB at once can hit SQLITE_BUSY. Keep busy_timeout before the WAL pragma (as `db.ts` already does) and use `CREATE TABLE IF NOT EXISTS`.
- A wrong Content-Type check: accept `application/json; charset=utf-8`, but reject a missing header.
- `typeof "3"` passes a loose number check if you coerce. Never use `Number()` coercion on the server.
- Retry delay outside 250 ms–2 s, or a slow poll: use a 500 ms delay and a 200 ms idle poll. This also meets the "start within 1 s" requirement.
- Do not double-increment attempts during crash recovery. Recovery only requeues; the claim increments. Note that a job killed during its third attempt that still has `failAttempts >= 3` would otherwise reach attempt 4. To prevent this, have recovery mark the job failed when `attempts >= 3 AND attempts <= fail_attempts`. More generally, a job never gets more than 3 attempts: in the claim's subquery, also require `attempts < 3`, and have recovery mark rows with `attempts >= 3` as failed with `'transient failure'`.
- If SIGTERM hangs, the check harness escalates to SIGKILL and reports an unclean shutdown. Use `closeAllConnections` and the forced-exit timers.
- Do not edit package.json or tsconfig. `node:sqlite` emits an ExperimentalWarning, which the npm scripts already suppress.