# Plan

## Approach
Put all the shared SQLite logic in `src/db.ts`: schema creation (run by both processes, so either can start first), turning a row into the job JSON, and the queries. `src/server.ts` becomes a `node:http` router that does strict validation and handles idempotency inside a `BEGIN IMMEDIATE` transaction, backed by a UNIQUE index on the key. `src/worker.ts` becomes a polling loop. It writes a heartbeat row every second, claims the oldest queued job that is due, runs steps of about 100 ms with a progress update after each, and handles retries with a `run_at` column. When the worker starts, it puts any `running` job back in the queue. `ui/index.html` is a single static page with inline JS. It polls `GET /api/jobs` every second and shows API errors in `form-error`.

## Files
- `src/db.ts`: keep `openDatabase` and add `migrate(db)` (create tables if missing). Add `rowToJob(row)`, `nowIso()`, the job types, and a `canonicalPayload({input,steps,failAttempts})` function that returns `JSON.stringify` with a fixed key order.
- `src/server.ts`: rewrite. Router, body reading, validation, idempotency, JSON errors, serving the UI, `/health` from the heartbeat, SIGTERM handling.
- `src/worker.ts`: rewrite. Recovery on startup, heartbeat interval, claim/process loop, retries, SIGTERM handling.
- `ui/index.html`: form plus job list with all the required `data-testid`s.

## Steps
1. **Schema** (in `migrate`, called from `openDatabase` after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
     input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0,
     result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     run_at INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_at, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL);
   ```
   `rowToJob` maps the columns to the exact JSON shape: `progress:{completed,total:steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`. Use `crypto.randomUUID()` for ids.
2. **Server helpers:** `send(res,status,body)` (already present; it sets `application/json`) and `sendError(res,status,code,message,fields?)`.
3. **Routing** on `pathname`:
   - `/` accepts GET only and serves the HTML.
   - `/health` accepts GET.
   - `/api/jobs` accepts GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` accepts GET.
   - Any other method on those paths returns 405 `method_not_allowed`. Any other path returns 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **`/health`:** `SELECT beat_at FROM heartbeat WHERE id=1`. `worker` is `up` if the row exists and `Date.now()-beat_at < 3000`.
5. **POST validation:** read the whole body first. Cap it at about 1 MB; if it is too large, return 400 with field `body`. Collect all errors into `fields[]`:
   - Content-Type: take the media type before `;`, trim it and lower-case it. If it is not `application/json` (or the header is missing), add a `body` error and skip parsing.
   - `JSON.parse` fails: `body`. Parsed value is null, an array, or not an object: `body`.
   - Unknown keys: one entry per key, with field set to that key.
   - `input`: must be `typeof 'string'`, `length` from 1 to 1000, and `trim()!==''`. Missing counts as an error.
   - `steps`: if present (`!== undefined`), must be `typeof 'number'`, `Number.isInteger`, and between 1 and 20. Otherwise default to 5.
   - `failAttempts`: same rule, between 0 and 5, default 0.
   - `Idempotency-Key` header: if present (`req.headers['idempotency-key']`, including the empty string), it must match `/^[A-Za-z0-9_-]{1,128}$/`. Otherwise add field `Idempotency-Key`.
   - If `fields` is not empty, return 400 `invalid_request`.
6. **Create the job:** compute `payload = canonicalPayload(...)`. Run `db.exec('BEGIN IMMEDIATE')`, then:
   - If there is a key, `SELECT * FROM jobs WHERE idempotency_key=?`. If the row exists, COMMIT. Return 200 with the job if `row.payload===payload`, otherwise 409 `idempotency_conflict`.
   - Otherwise INSERT with status `queued`, attempts 0, run_at 0, and created/updated set to now. COMMIT and return 201 with the job.
   - ROLLBACK if anything throws. If the INSERT fails on the UNIQUE constraint, re-select and apply the same comparison.
7. **List and get:**
   - `GET /api/jobs`: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs}`. Sort by `seq`, not `created_at`, because timestamps can tie.
   - `GET /api/jobs/:id`: return the job, or 404 `not_found`.
8. **Server shutdown on SIGTERM/SIGINT:** `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`.
9. **Worker startup:** open the db (this runs migrate). Recover with one statement:
   ```sql
   UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0,
     run_at=0, updated_at=? WHERE status='running'
   ```
   The interrupted attempt is redone, so the total stays at most 3 and the "attempt n fails if n ≤ failAttempts" rule still holds. Then write the heartbeat immediately (`INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`) and repeat it with `setInterval(…,1000)`. The awaits in the step sleeps let the interval run.
10. **Worker loop:** `while(!stopping)`:
    - Find the next job: `SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY seq LIMIT 1`.
    - If there is none, `await sleep(200)` and loop.
    - Claim it: `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`. Skip if `changes===0`.
    - Re-read the row to get `attempts`.
    - **Failing attempt** (`attempts <= fail_attempts`): `await sleep(100)`. If `attempts < 3`, set status `queued`, `run_at=Date.now()+500`, progress 0. Otherwise set status `failed`, `error='transient failure'`, `result_output=NULL`.
    - **Normal attempt:** for i in 1..steps, `await sleep(100)`. If stopping, break out and leave the job for recovery (or requeue it with the same decrement). Otherwise `UPDATE progress_completed=i, updated_at`.
    - **After the last step:** `UPDATE status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Update `updated_at` on every write.
11. **Worker shutdown on SIGTERM/SIGINT:** set `stopping`, which ends the loop within one step. Then `clearInterval`, set the heartbeat `beat_at=0`, `db.close()`, `process.exit(0)`. Also add a fallback `setTimeout(()=>process.exit(0),2000).unref()`.
12. **UI** (`ui/index.html`):
    - Markup: `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button data-testid="job-submit" type="submit">`
      - `<div data-testid="form-error" role="alert"></div>`, empty by default
      - `<ul data-testid="job-list">`
    - On submit: `preventDefault`. Build the body as `{input: value}`. For each numeric field whose value is not empty, use `Number(value)` (send the raw string if `Number` gives NaN, so the API rejects it). POST with the `application/json` header.
    - If the response is not OK, set `form-error` to `error.message` plus one line per field: `"<field>: <message>"`.
    - If it succeeds, clear `form-error`, clear the input, and refresh the list right away.
    - Poll `GET /api/jobs` every 1000 ms. Re-render the `<li data-testid="job-item" data-job-id>` elements, each with spans for `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`).
    - Use `textContent` only, never innerHTML with user data.
13. Run `npm run build`, then the checks: `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and startup:** run `npm run build`. Start the server and worker in either order with a temporary `DATABASE_PATH` in a directory that does not exist yet. The directory should be created and both processes should log within 10 s.
- **Health:** `curl /health` shows `up` while the worker runs, and `down` within 3 s of `kill -TERM` on the worker.
- **Validation:** each of these returns 400 with the right `fields`:
  - `steps:"3"`, `steps:2.5`, `steps:0`, `failAttempts:6`
  - an unknown key
  - `input:"   "`, and an input of 1001 characters
  - `[]`, `null`, a malformed body
  - a `text/plain` Content-Type, and no Content-Type
  - `Idempotency-Key: bad key!`

  Afterwards, `GET /api/jobs` count has not changed.
- **Defaults:** `{"input":"a"}` returns 201 with steps 5, failAttempts 0, queued, `progress {0,5}`, result and error null.
- **Idempotency:**
  - Same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}`: 201, then 200 with the same id.
  - Same key with a different input: 409.
  - Restart the server and replay: still 200 with the same id.
- **Routing:** `/nope` returns 404. `DELETE /api/jobs` returns 405. `GET /api/jobs/xyz` returns 404 `not_found`.
- **Progress:** poll a job with 10 steps every 100 ms. `progress.completed` goes up step by step, and the job reaches `completed` with the output upper-cased (try `ß` → `SS`).
- **Retries:** `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with `"transient failure"`, attempts 3 and result null.
- **Crash recovery:** start a job with 20 steps, `kill -9` the worker mid-run, restart it. The job completes within about 10 s plus its processing time, and attempts stay at most 3.
- **Persistence:** `kill -9` both processes and restart them. All jobs are still present, and completed jobs are unchanged.
- **UI:** open `/`. Submit a valid job and watch status and progress update without reloading. Submit steps=50: `form-error` shows `steps`.

## Risks
- **Browser validation blocking submit:** native validation could block bad values so they never reach the API. Use `novalidate`, and don't put `min`/`max`/`required` on the inputs.
- **Ordering by `created_at`:** ties at millisecond resolution break newest-first. Sort by `seq`.
- **Shutdown hangs:** keep-alive connections or the worker loop can stop the process from exiting. Use `closeAllConnections` and explicit `process.exit`.
- **`SQLITE_BUSY`:** keep `busy_timeout`, and keep transactions short. Never hold a transaction across an `await`.
- **Boolean/typeof traps:** `typeof null === 'object'` and arrays are objects. Check for both explicitly. Treat `steps: null` as a wrong type, not as missing.
- **Recovery inflating attempts:** without the decrement, an attempt-3 crash would lead to a 4th attempt or break the failAttempts semantics.
- **Import paths:** keep the `.ts` relative import extensions (tsconfig rewrites them). Keep the UI path `new URL('../ui/index.html', import.meta.url)`, which resolves from `dist/`.
- **Heartbeat freshness:** write it immediately at startup, not only after the first interval, so `up` shows quickly.