# Plan

## Approach
Keep the existing layout (`src/server.ts`, `src/worker.ts`, `src/db.ts`, `ui/index.html`, compiled by `tsc` to `dist/`). `src/db.ts` holds everything shared: the schema, row-to-JSON mapping, and the claim/progress/finish queries. Both processes use synchronous `node:sqlite` `DatabaseSync` with WAL and a busy timeout. The worker polls every ~200 ms and writes a heartbeat every ~500 ms. It claims jobs atomically and recovers stale `running` jobs at startup. The server is a plain `node:http` router with strict validation and idempotency, and the idempotency key has a UNIQUE constraint in SQLite. The UI is one static HTML page with inline JS that polls `GET /api/jobs` every ~700 ms and rebuilds the list.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` schema, `rowToJob`, `nowIso`, and the shared query helpers.
- `src/server.ts`: rewrite. Add routing, JSON body reading, validation, idempotency, the health check, UI serving and SIGTERM handling.
- `src/worker.ts`: rewrite. Add the heartbeat, startup recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: form, error region, job list and polling script, with all the required `data-testid`s.

## Steps
1. **Schema** (run inside `openDatabase` after the pragmas, so either process can start first):
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status TEXT, input TEXT, steps INT, fail_attempts INT, attempts INT DEFAULT 0, progress INT DEFAULT 0, output TEXT NULL, error TEXT NULL, created_at TEXT, updated_at TEXT, run_after INTEGER NOT NULL DEFAULT 0, idem_key TEXT UNIQUE NULL, idem_payload TEXT NULL)`.
   - `CREATE INDEX IF NOT EXISTS ON jobs(status, run_after, seq)`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER)`, holding ms epoch.
   - `seq` is a monotonic ordering key, computed as `COALESCE(MAX(seq),0)+1` inside the insert transaction. Order by `seq` rather than `created_at`, which can tie within the same millisecond.
   - `id` is `crypto.randomUUID()`.
2. **`rowToJob`**: build the exact JSON shape from the task.
   - `progress: {completed: progress, total: steps}`.
   - `result`: `{output}` when status is `completed`, else `null`.
   - `error`: the error text when status is `failed`, else `null`.
3. **Server routing**:
   - Parse `pathname`, then dispatch:
     - `/health`: GET only.
     - `/`: GET only, serves the HTML.
     - `/api/jobs`: GET and POST.
     - `/api/jobs/:id`, matched by `^/api/jobs/([^/]+)$`: GET only.
   - A known path with the wrong method returns 405 `method_not_allowed`. Anything else returns 404 `not_found`.
   - Every JSON response sets `Content-Type: application/json; charset=utf-8`.
   - Wrap handlers in try/catch so failures return 500 `{error:{code:'internal_error',...}}`.
4. **Health**: read `worker_heartbeat.at`. `worker` is `"up"` iff `Date.now() - at < 3000`.
5. **POST validation**. Collect the `fields` errors in a list:
   - **Content-Type**: lowercase it, split on `;`, and require the media type to be `application/json`. If missing or anything else, error on field `body`.
   - **Idempotency-Key**: if the header is present (even empty), it must match `^[A-Za-z0-9_-]{1,128}$`, else error on field `Idempotency-Key`.
   - **Body**: read it fully and run `JSON.parse` in a try/catch; malformed JSON is an error on `body`. If the result is not a plain object (null, array or primitive), that is also an error on `body`.
   - **Unknown keys**: each one is a field error named after the key.
   - **`input`**: must be `typeof 'string'`, with `length` from 1 to 1000 and `trim() !== ''`.
   - **`steps`** (only if present): must be `typeof 'number'`, `Number.isInteger`, and in 1–20.
   - **`failAttempts`** (only if present): same checks, range 0–5.
   - If there are any errors, return 400 `invalid_request` with `fields`.
   - Otherwise apply the defaults: steps 5, failAttempts 0.
6. **Create with idempotency**. Run this in `BEGIN IMMEDIATE`…`COMMIT`, with ROLLBACK on error:
   - Set `payload = JSON.stringify({input, steps, failAttempts})`, always with keys in that order.
   - If there is a key, `SELECT` by `idem_key`:
     - Found and `idem_payload === payload`: return 200 with that job.
     - Found and different: return 409 `idempotency_conflict`.
   - Otherwise insert with `status='queued'`, `attempts=0`, `progress=0` and `run_after=0`, and return 201.
   - The UNIQUE constraint backstops races. If you catch a constraint error, re-select and handle it as a replay.
7. **GET list**: `SELECT * FROM jobs ORDER BY seq DESC` and return `{jobs}`. **GET by id**: return 200 with the job, or 404 `not_found`.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `db.close()`, then `process.exit(0)`. Add a 2 s fallback timer, and call `server.closeAllConnections?.()` so keep-alive connections don't block exit.
9. **Worker startup**:
   - Open the DB and write the heartbeat immediately.
   - Start `setInterval(heartbeat, 500)`, which runs an UPSERT into `worker_heartbeat`.
   - **Recovery**: `UPDATE jobs SET status='queued', progress=0, run_after=0, updated_at=? WHERE status='running'`. Only one worker exists, so any `running` row at startup is stale. Re-running it starts a new attempt, so `attempts` increments as usual. If it already had 3 attempts, the step-10 check handles it.
10. **Claim loop**: `while (!stopping)`, try to claim a job.
    - Run this in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq ASC LIMIT 1`.
    - If the job has already used `attempts >= 3`, mark it `failed` with `error='transient failure'` instead of running it. This only happens via recovery.
    - Otherwise run `UPDATE status='running', attempts=attempts+1, progress=0, output=NULL, error=NULL, updated_at=now`, then COMMIT.
    - If nothing was claimed, sleep 200 ms.
11. **Process an attempt** (attempt number `n` is the new `attempts`):
    - If `n <= fail_attempts`, the attempt fails at step 1 with no progress:
      - If `n < 3`, set `status='queued'`, `progress=0`, `run_after=now+500` and update `updated_at`.
      - Otherwise set `status='failed'`, `error='transient failure'`, `output=NULL`.
    - Else, for each step i = 1..steps:
      - Sleep 100 ms.
      - Run `UPDATE progress=i, updated_at` with a `WHERE id=? AND status='running'` guard.
      - Then set `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
    - If `stopping` becomes true mid-job, just exit. The job stays `running` and recovery picks it up on the next start, which is acceptable. A cleaner option is to set it back to `queued` with `attempts=attempts-1` before exiting.
12. **Worker shutdown**: on SIGTERM, set `stopping=true`, let the loop break within ≤100 ms, clear the interval, close the DB and exit 0.
13. **UI** (`ui/index.html`):
    - Form elements:
      - `form[data-testid=job-form]`
      - `input[data-testid=job-input]` (text)
      - `input type=number data-testid=job-steps value=5`
      - `input type=number data-testid=job-fail-attempts value=0`
      - `button[data-testid=job-submit] type=submit`
      - `div data-testid=form-error role=alert`, initially empty
      - `ul data-testid=job-list`
    - On submit:
      - Call `preventDefault()` and clear `form-error`.
      - Build the body as `{input, steps: Number(stepsVal), failAttempts: Number(failVal)}`. Send the raw number even if it is invalid (e.g. 0 or 1.5) so the API validates it. If a numeric field is empty, omit it.
      - POST with `Content-Type: application/json`. Do not use HTML `min`/`max`/`required`/`step` attributes, which would block submission before the API sees it. Add `novalidate` on the form.
      - On a non-2xx response, set `form-error.textContent` to `message` plus each `field: message`.
      - On success, refresh the list immediately.
    - Poll with `setInterval(refresh, 700)`.
    - The list renders each job as `li data-testid=job-item data-job-id=ID` containing:
      - the input text;
      - `span data-testid=job-status`;
      - `span data-testid=job-progress` with text `completed/total`;
      - `span data-testid=job-result` with the output when completed, the error when failed, else empty.
    - Use `textContent` everywhere (no innerHTML with user data).
14. Run `npm run build`, then smoke-test as below and run `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and start**: `npm run build`, then `PORT=3000 DATABASE_PATH=/tmp/t/jobs.db npm run start:server` and `npm run start:worker` in either order. Both should be up in under 10 s, and `/tmp/t` should be created.
- **Health**: `curl localhost:3000/health` shows `worker:"up"`. Stop the worker; within 3 s it shows `"down"`.
- **Create and progress**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hello","steps":3}' localhost:3000/api/jobs` returns 201 with `queued`. Poll `/api/jobs/:id`: progress goes 1/3, 2/3, then `completed` with `result.output "HELLO"` and `attempts 1`.
- **Retries**: `failAttempts:2` completes with `attempts 3`. `failAttempts:3` ends `failed` with error `"transient failure"`, `attempts 3`, `result null`. Status shows `queued` between attempts.
- **Validation**: each of these returns 400 with the right `fields`:
  - `"steps":"3"`, `steps:0`, `steps:1.5`, `steps:21`, `failAttempts:6`;
  - an unknown key `x`;
  - `input:"   "`, and `input` of length 1001;
  - body `[]`, body `null`, body `{bad`;
  - no Content-Type, or `text/plain`;
  - an `Idempotency-Key` with a space or 129 characters.
- **Idempotency**:
  - Key K with `{"input":"a"}` gives 201. Repeating it with `{"input":"a","steps":5,"failAttempts":0}` gives 200 with the same id.
  - `{"input":"b"}` with K gives 409.
  - Restart the server and replay: still 200, same id, and `GET /api/jobs` count unchanged.
- **Routes**: `GET /nope` gives 404 `not_found`. `DELETE /api/jobs` and `POST /health` give 405. `GET /api/jobs/unknown` gives 404.
- **Crash recovery**: submit `steps:20` and `kill -9` the worker mid-run. Restart it: the job completes with `attempts 2`. Completed jobs keep their attempts unchanged after the restart.
- **UI**: open `/`, submit `steps 0` and see an error mentioning `steps` in `form-error`. Submit a valid job and watch status and progress update live without a reload.

## Risks
- **Default values hiding errors.** Using `?? 5` before the type check would let a `null` or wrong-typed `steps` through. Check for presence with `'steps' in body`, then validate the type strictly. An explicit `null` is invalid.
- **SQLITE_BUSY between the processes.** Keep transactions short and synchronous: no `await` inside `BEGIN`…`COMMIT`. Use `BEGIN IMMEDIATE` and keep `busy_timeout`.
- **Wrong UI path.** `server.ts` reads `../ui/index.html` relative to `dist/`, which resolves to the repo-root `ui/` and is correct. Keep it that way, and don't move `ui/` under `src/`.
- **HTML form validation blocks bad submissions.** Use `novalidate`, and don't use `min`/`max`, so invalid values reach the API.
- **Retry delay outside 250 ms–2 s.** Use `run_after` (500 ms) and a 200 ms poll so the actual delay is about 500–700 ms. The 1 s pickup latency is also met.
- **Step timing outside 50–500 ms.** Make the step sleep exactly 100 ms. Combined with the DB write, it stays well within range.
- **Worker hangs on SIGTERM.** Clear the heartbeat interval and keep sleeps short. Call `process.exit(0)` after cleanup.
- **Server not exiting promptly on SIGTERM.** Keep-alive sockets keep `server.close()` waiting, so call `closeAllConnections()` and keep the fallback exit.
- **`node:sqlite` value types.** Rows come back with numbers as JS numbers, possibly bigint for large values. Coerce with `Number()` in `rowToJob`, and pass `null`, never `undefined`, as a bound parameter.
- **TS imports.** Keep the `.ts` extension in relative imports, since `rewriteRelativeImportExtensions` is on.