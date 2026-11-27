# Plan

## Approach
Keep the existing layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` is a `node:http` server, `src/worker.ts` is a polling loop, and `ui/index.html` is one static page with an inline script. All state is in SQLite through `node:sqlite` `DatabaseSync`, with WAL mode and the busy_timeout already set in `openDatabase`. A `jobs` table keeps an insertion sequence for ordering, a UNIQUE `idempotency_key` with a canonical payload string, and a `run_after` time (ms) for retry delays. A `heartbeat` table lets the server report whether the worker is up. The worker claims jobs with one atomic `UPDATE … RETURNING`, writes progress after every step, and on startup requeues any job left `running` by a crash.

## Files
- `src/db.ts`: keep `openDatabase`. After the pragmas, run `CREATE TABLE IF NOT EXISTS` for both tables. Add a `JobRow` type, `rowToJob(row)` that builds the exact API JSON shape, and `nowIso()`.
- `src/server.ts`: rewrite with routing, validation, idempotency, health and graceful shutdown. Keep the `../ui/index.html` read (it resolves from `dist/`).
- `src/worker.ts`: rewrite with crash recovery, heartbeat, claim/process loop, retries and graceful shutdown.
- `ui/index.html`: form, error region, job list and a polling script, using all the required `data-testid`s.

## Steps
1. **Schema** (in `db.ts`):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(name TEXT PRIMARY KEY, ts INTEGER NOT NULL);
   ```
   `rowToJob`: `progress: {completed: progress_completed, total: steps}`, `result: status==='completed' ? {output: result_output} : null`, `error: status==='failed' ? error : null`.
2. **Server helpers**: `send(res, status, body)` always sends `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)`. Read the body as a Buffer with a 1 MB cap; anything bigger is a 400 on `body`.
3. **Routing** (`new URL(req.url,…).pathname`):
   - `/` accepts GET only and returns HTML.
   - `/health` accepts GET only. Read `SELECT ts FROM heartbeat WHERE name='worker'`; `worker` is `"up"` if `Date.now()-ts < 3000`.
   - `/api/jobs` accepts GET (list ordered `seq DESC`) and POST.
   - `^/api/jobs/([^/]+)$` accepts GET only: decodeURIComponent the id, then return the job or 404 `not_found`.
   - Any other method on those paths gets 405 `method_not_allowed`. Any other path gets 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **POST validation**: collect `fields[]`. Do not stop at the first error, except where noted.
   - The `Idempotency-Key` header, if present (`req.headers['idempotency-key']`), must match `/^[A-Za-z0-9_-]{1,128}$/`. Otherwise add field `Idempotency-Key`.
   - The content-type, lowercased and split at `;` then trimmed, must equal `application/json`. Otherwise add `body` and respond.
   - Run `JSON.parse` in try/catch; on failure add `body`. A parsed value that is not a plain object (null, array or primitive) also adds `body`.
   - Each unknown key gets its own field entry.
   - `input` must be `typeof string`, have length 1–1000, and `trim() !== ''`.
   - `steps`, if present (not `undefined`), must pass `Number.isInteger` and be 1–20. Otherwise default it to 5. `failAttempts` works the same way with range 0–5, default 0. A `"3"` string fails `Number.isInteger`.
   - Any errors give 400 `invalid_request` with `fields`.
5. **Create and idempotency**: build the canonical `payload = JSON.stringify({input, steps, failAttempts})`.
   - If a key is present, `SELECT` by `idempotency_key`. A match with the same payload returns 200 with the job. A match with a different payload returns 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = crypto.randomUUID()`, status `queued`, `run_after = 0`, and timestamps from `new Date().toISOString()`. Return 201.
   - Wrap the INSERT so a UNIQUE-constraint error re-selects and applies the same comparison. `DatabaseSync` is synchronous, so a single server is already race-free.
6. **Server shutdown**: on SIGTERM/SIGINT run `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a 2 s `setTimeout(...).unref()` force-exit as a fallback. Log `server listening on PORT` once listening.
7. **Worker startup recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. This assumes a single worker. The interrupted attempt does not count, so the cap of 3 attempts and the `n ≤ failAttempts` rule still hold.
8. **Heartbeat**: `setInterval` every 1000 ms (also once right away) runs `INSERT INTO heartbeat(name,ts) VALUES('worker',?) ON CONFLICT(name) DO UPDATE SET ts=excluded.ts`.
9. **Claim** (loop while not stopping, polling every 200 ms when idle):
   ```sql
   UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
   WHERE id=(SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1)
   RETURNING *
   ```
10. **Process a claimed job** with attempt `n = row.attempts`:
    - If `n <= fail_attempts`, sleep 100 ms and fail the attempt with progress still 0:
      - if `n < 3`: `status='queued', run_after=Date.now()+500`;
      - otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - Otherwise, for each step i = 1..steps: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. If `stopping` becomes true between steps, requeue the job (`status='queued', attempts=attempts-1, progress_completed=0`) and leave the loop.
    - After the last step: `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Every update sets `updated_at` and includes `WHERE id=? AND status='running'`.
11. **Worker shutdown**: SIGTERM sets `stopping`. The loop then finishes or requeues the current job, clears the interval, deletes the heartbeat row (so health shows down right away), closes the db and exits 0. Add a 3 s force-exit fallback.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` with:
      - `input[data-testid=job-input]`;
      - `input[type=number][data-testid=job-steps]` (value 5);
      - `input[type=number][data-testid=job-fail-attempts]` (value 0);
      - `button[type=submit][data-testid=job-submit]`.
    - `<div data-testid="form-error" role="alert"></div>`, empty by default, and `<ul data-testid="job-list">`.
    - On submit, `preventDefault`. For each numeric field: if it is empty, omit it; if `Number(v)` is finite, send the number; otherwise send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`. On a non-2xx response, fill form-error with `error.message` plus one line per field (`<field>: <message>`). On success, clear form-error and refresh the list.
    - Poll `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>` containing spans for `job-status`, `job-progress` (`completed/total`) and `job-result` (`result.output`, or `error`, or empty).
    - Use `textContent` only, never innerHTML with job data, and rebuild only the list so form focus is kept.

## Behaviours to verify
- Build and start: run `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server` and `start:worker` in either order. Both log within 10 s and `/tmp/jt` is created.
- Health: `curl :3100/health` shows `worker:"up"`. After you SIGTERM the worker it shows `"down"` within 3 s.
- Contract and smoke: `npm run check:contract` and `npm run check:smoke` both pass. Read `checks/cli.ts` for the env vars and arguments they expect.
- Validation: curl with `{"input":"x","steps":"2"}`, `failAttempts:7`, an unknown `colour`, a missing input, `[1]`, broken JSON, no content-type, and a bad key `a b`. Each gives 400 with the right `fields[].field`, and the job count stays the same.
- Idempotency: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` gives 201 then 200 with the same id. A different input gives 409. The replay still works after a server restart.
- Processing: with `steps:10`, polling GET shows progress rising. The job ends `completed` with uppercase output, and `attempts` is 1.
- Retries: `failAttempts:2` gives completed with attempts 3. `failAttempts:3` gives failed with `error:"transient failure"`, attempts 3 and result null. Only one job exists.
- Crash recovery: start a `steps:20` job, `kill -9` the worker mid-run and restart it. The job completes. Completed jobs are left alone, and their `updated_at` does not change.
- 404 and 405: `GET /nope` gives 404 and `DELETE /api/jobs` gives 405, both as JSON.
- UI: open `/`, submit a valid job and watch status and progress update. Submit steps 50 and form-error shows `steps`.

## Risks
- **Relative imports**: these must keep the `.ts` extension (`./db.ts`), because the tsconfig uses `rewriteRelativeImportExtensions`. Do not switch them to `.js`.
- **Browser validation**: native constraint validation could block bad values before they reach the API. Keep `novalidate` and leave out `required`/`min`/`max`, or the UI test for API rejections can't fire.
- **Defaults vs. type errors**: `steps: null` must be rejected, not defaulted. Only `undefined` gets the default.
- **Ordering**: sort by `seq DESC`, not by timestamp. Two jobs can share the same millisecond.
- **Process exit**: an open http server, interval or db handle can keep a process alive after SIGTERM. Close everything and call `process.exit(0)`.
- **Locking**: use short statements and no long transactions across `await`, so the server's reads never wait on the worker's writes.
- **Error responses**: every one, including 404, 405 and 500, must use the JSON content-type and the `{error:{code,message}}` shape.