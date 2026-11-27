You are implementing a small application in the current Git repository. A planner has already inspected the repository and written the plan below. Follow it where it is sound; the task is the authority if they disagree.

## Task

# Job tracker

Build a small asynchronous job tracker: an HTTP API and a browser page for submitting jobs, a separate worker process that processes them, and durable state in SQLite shared by both processes.

The repository already contains a starting point. Keep the existing commands and file layout working. You may add, change, or remove source files under `src/` and `ui/`.

## Fixed files and constraints

- Do not modify `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, this file, or anything under `checks/`.
- Do not add dependencies. Use Node.js 22 built-ins (`node:http`, `node:sqlite`, and so on). Dependencies are already installed, and there is no network access.
- The server and worker must be separate processes that communicate only through the SQLite database.

## Commands and configuration

- `npm run build` compiles `src/` to `dist/`.
- `npm run start:server` starts the HTTP server. `npm run start:worker` starts the worker. Either may start first.
- `PORT`: server port, default `3000`.
- `DATABASE_PATH`: SQLite file path, default `data/jobs.db`. Both processes use the same value. Create the parent directory if it is missing.
- Both processes must start within 10 seconds and shut down cleanly on `SIGTERM`.

## Jobs

A job takes a text `input` and processes it in `steps` steps. When processing finishes, the job's output is `input` converted with JavaScript's `String.prototype.toUpperCase()`.

### Job representation

Every endpoint that returns a job uses this JSON shape:

```json
{
  "id": "string, unique, assigned by the server",
  "status": "queued | running | completed | failed",
  "input": "the submitted input",
  "steps": 5,
  "failAttempts": 0,
  "attempts": 0,
  "progress": { "completed": 0, "total": 5 },
  "result": null,
  "error": null,
  "createdAt": "ISO 8601 timestamp",
  "updatedAt": "ISO 8601 timestamp"
}
```

- `attempts` is the number of processing attempts started so far.
- `progress.total` equals `steps`. `progress.completed` counts the steps finished in the current attempt.
- `result` is `{ "output": "..." }` once the job is `completed`, otherwise `null`.
- `error` is a string once the job is `failed`, otherwise `null`.

## HTTP API

All API responses are JSON with `Content-Type: application/json`. Errors use this shape:

```json
{ "error": { "code": "string", "message": "string", "fields": [{ "field": "string", "message": "string" }] } }
```

`fields` is required for `invalid_request` and optional otherwise.

### `GET /health`

`200 {"status": "ok", "worker": "up" | "down"}`. `worker` is `"up"` only if the worker process has shown it is alive within the last 3 seconds, for example by writing a heartbeat to the database.

### `POST /api/jobs`

Request: `Content-Type: application/json`, with a body like `{"input": "hello", "steps": 3, "failAttempts": 0}`, and an optional `Idempotency-Key` header.

- `201` with the new job, in status `queued`, when a job is created.
- `200` with the existing job for an idempotent replay (see Idempotency).
- `400` with code `invalid_request` for invalid input (see Validation). No job is created.
- `409` with code `idempotency_conflict` (see Idempotency). No job is created.

### `GET /api/jobs`

`200 {"jobs": [ ...jobs ]}`, newest first.

### `GET /api/jobs/:id`

`200` with the job, or `404` with code `not_found`.

### Other routes

An unknown path returns `404` with code `not_found`. A wrong method on a known path returns `405` with code `method_not_allowed`.

## Validation

The body must be a JSON object with only these fields:

| Field | Rule | Default |
| --- | --- | --- |
| `input` | Required string, 1–1000 characters (JavaScript string length), not only whitespace. Stored exactly as sent. | — |
| `steps` | Integer from 1 to 20. | 5 |
| `failAttempts` | Integer from 0 to 5. | 0 |

All of the following are rejected with `400 invalid_request`, with each offending field listed in `fields` (use `"body"` when the body as a whole is the problem):

- unknown fields;
- wrong types, including numeric strings such as `"3"`;
- out-of-range or non-integer numbers;
- malformed JSON;
- a body that is not an object;
- a missing or non-JSON `Content-Type`;
- an `Idempotency-Key` not matching `^[A-Za-z0-9_-]{1,128}$` (field `"Idempotency-Key"`).

## Idempotency

When `Idempotency-Key` is present, the submission is compared with any earlier submission that used the same key. The comparison uses the payload after defaults are applied, so `{"input": "a"}` and `{"input": "a", "steps": 5, "failAttempts": 0}` are the same payload.

- Same key, same payload: return `200` with the original job. No new job.
- Same key, different payload: return `409 idempotency_conflict`. No new job.
- A key never creates more than one job, including across server restarts.
- Submissions without a key always create a new job.

## Processing

- The worker picks up queued jobs, oldest first, one at a time. An idle worker starts a newly queued job within 1 second.
- An attempt sets the job to `running`, increments `attempts`, and resets `progress.completed` to 0.
- Each step takes about 100 ms (between 50 and 500 ms). Update `progress.completed` in the database after each step, so progress is observable while the job runs.
- After the last step, the job becomes `completed` with `result.output` set and `progress.completed` equal to `steps`.

## Transient failures and retries

`failAttempts` simulates an unreliable dependency. Attempt number *n* (counting from 1) fails at its first step, before any progress, if *n* ≤ `failAttempts`.

- A failed attempt is retried after a delay of between 250 ms and 2 seconds, up to **3 attempts in total**. The job returns to `queued` while it waits.
- After the third failed attempt, the job becomes `failed`, with `error` set to `"transient failure"`, `result` set to `null`, and `attempts` set to 3.
- Retries continue the same job. They never create another job or another result.

For example, `failAttempts: 2` completes on attempt 3, and `failAttempts: 3` or more ends `failed`.

## Durability and restarts

All job state lives in SQLite at `DATABASE_PATH`.

- If the server and worker are stopped, gracefully or abruptly with `SIGKILL`, and started again with the same `DATABASE_PATH`, every job and its status are still there.
- A job that was `running` when the worker died is processed again. It completes, or fails per the retry rules, within 10 seconds of the worker restarting, plus its own processing time.
- Completed and failed jobs are never reprocessed.

## Browser UI

`GET /` serves an HTML page that uses the API. The evaluator finds elements by these `data-testid` attributes:

| `data-testid` | Element |
| --- | --- |
| `job-form` | The submission form |
| `job-input` | Text field for `input` |
| `job-steps` | Field for `steps` |
| `job-fail-attempts` | Field for `failAttempts` |
| `job-submit` | Submit button |
| `form-error` | Region with `role="alert"`. When the API rejects a submission, it shows the rejection, including each offending field's name. It is empty otherwise. |
| `job-list` | List of jobs, newest first |
| `job-item` | One element per job inside `job-list`, carrying `data-job-id="<id>"` |
| `job-status` | Inside each `job-item`: the job's `status` text |
| `job-progress` | Inside each `job-item`: `<completed>/<total>`, for example `3/5` |
| `job-result` | Inside each `job-item`: `result.output` once completed, the `error` text once failed, otherwise empty |

The page reflects status and progress changes within 2 seconds without a manual reload. Submitting through the form sends the field values to `POST /api/jobs` as numbers where numeric, so the API's validation applies.

## Plan

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

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
