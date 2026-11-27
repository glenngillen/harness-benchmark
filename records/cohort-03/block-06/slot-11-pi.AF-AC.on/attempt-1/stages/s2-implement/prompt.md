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
Keep the current layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (node:http API plus the UI), `src/worker.ts` (polling worker), and `ui/index.html` (a static page with inline JS). The two processes share one SQLite file in WAL mode, which `db.ts` already sets up. It holds two tables: `jobs`, and a single-row `heartbeat` table that the worker updates every 500 ms. The worker claims jobs atomically inside `BEGIN IMMEDIATE` transactions. It handles retry delays with a `run_after` timestamp column. When it starts, it puts any jobs left in `running` back in the queue. For idempotency, the server stores a UNIQUE `idempotency_key` and the canonical payload JSON on the job row.

## Files
- `src/db.ts`: keep `openDatabase`. After the pragmas, add `CREATE TABLE IF NOT EXISTS` for the schema. Export a `JobRow` type, a `toJob(row)` mapper and a `nowIso()` helper.
- `src/server.ts`: rewrite with routing, validation, idempotency, health, serving the UI, and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, recovery, the claim loop, step processing, retries, and SIGTERM handling.
- `ui/index.html`: the form, the list, polling, and error display, using the exact `data-testid`s.

## Steps
1. **Schema** in `db.ts`, executed on every open from both processes (idempotent):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL,
     steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0,
     result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,  -- epoch ms
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL);
   ```
   `toJob` returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
2. **Server helpers**: `send(res, status, body)` always sets `content-type: application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)` uses the shape from the task.
3. **Routing** (use `pathname` from `new URL`):
   - `/health`: GET only.
   - `/`: GET only, returns the HTML.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/:id`: matches `^/api/jobs/([^/]+)$`, GET only.

   A known path with any other method gets `405 method_not_allowed` and an `Allow` header. Anything else gets `404 not_found`. Wrap the handler in try/catch and return `500 internal_error` on unexpected errors.
4. **Health**: `SELECT beat_at FROM heartbeat WHERE id=1`. Report `worker: "up"` if the row exists and `Date.now() - beat_at < 3000`.
5. **POST validation**: collect every error before responding.
   - Read the body as a Buffer, capped at about 1 MB (return 400 with field `"body"` if larger).
   - Content type: take `content-type`, split on `;`, trim and lowercase. It must equal `application/json`. Otherwise add errors for both `"body"` and `"Content-Type"`.
   - Idempotency key: if `req.headers['idempotency-key'] !== undefined` and it does not match `/^[A-Za-z0-9_-]{1,128}$/`, add an error for `"Idempotency-Key"`. An empty string is invalid.
   - Body shape: run `JSON.parse` in try/catch. Malformed JSON gives an error on `"body"`. If the result is not a plain object (null, an array or a primitive), also use `"body"`.
   - Unknown keys: one error per key, named after the key.
   - `input`: must be a string with `length` from 1 to 1000 and `trim() !== ''`. Store it untouched.
   - `steps`: if present (`!== undefined`), it must satisfy `typeof === 'number' && Number.isInteger && 1 ≤ v ≤ 20`. `null` and `"3"` are rejected.
   - `failAttempts`: same check, range 0 to 5.

   If there are any errors, return `400 invalid_request` with `fields`.
6. **Create**: apply defaults, then `payload = JSON.stringify({input, steps, failAttempts})`, always with keys in that order.
   - With a key: `SELECT * FROM jobs WHERE idempotency_key=?`. If a row exists, return `200` with `toJob(row)` when `row.payload === payload`, otherwise `409 idempotency_conflict`.
   - Otherwise insert with `id = crypto.randomUUID()`, `status='queued'`, `run_after=0`, and both timestamps set to `new Date().toISOString()`.
   - Wrap the select and insert in `BEGIN IMMEDIATE`/`COMMIT`. If the insert throws a UNIQUE error, re-select and handle it as a replay. Return `201` with the job.
7. **List and get**: `SELECT * FROM jobs ORDER BY seq DESC` returns `{jobs}`. Get by `id` returns the job or `404 not_found`.
8. **Server shutdown**: on SIGTERM or SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a 3 s `setTimeout(...).unref()` that forces the exit.
9. **Worker startup**:
   - Open the database, which creates the schema.
   - Write the heartbeat (`INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=?`) right away, then every 500 ms with `setInterval`.
   - Recovery:
     ```sql
     UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0),
       progress_completed=0, run_after=0, updated_at=? WHERE status='running'
     ```
     The interrupted attempt is re-run as the same attempt number. This keeps the `failAttempts` behaviour exact and `attempts` ≤ 3.
10. **Worker loop**: `while (!stopping)`, claim a job inside `BEGIN IMMEDIATE`:
    ```sql
    SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1
    ```
    If one is found:
    ```sql
    UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=?
    ```
    Then `COMMIT`, with `ROLLBACK` on error. If there is no job, sleep 200 ms.
11. **Process an attempt** (`n` = the new attempt count):
    - Sleep 100 ms. If `n <= fail_attempts`, the attempt fails:
      - When `n < 3`: `status='queued', progress_completed=0, run_after=now+500`.
      - Otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - If it does not fail, loop `i = 1..steps`: sleep 100 ms, then update `progress_completed=i, updated_at`. If `stopping` becomes true between steps, put the job back in the queue (`attempts-1`, progress 0) and return.
    - Finish with `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Every update includes `WHERE id=? AND status='running'`.
12. **Worker shutdown**: SIGTERM or SIGINT sets `stopping`. After the loop, clear the interval, optionally set `beat_at=0`, close the database and exit 0. Add a 4 s forced exit as a fallback.
13. **UI** (`ui/index.html`):
    - Markup: `<form data-testid="job-form" novalidate>`.
      - `<input data-testid="job-input" type="text">`, with no `maxlength` or `required`.
      - `<input data-testid="job-steps" type="number" value="5">` and `<input data-testid="job-fail-attempts" type="number" value="0">`, with no `min`, `max` or `required`.
      - `<button data-testid="job-submit" type="submit">`.
      - `<div data-testid="form-error" role="alert"></div>`.
      - `<ul data-testid="job-list">`.
    - Submit:
      - Run `preventDefault()`.
      - Build the body: `input` as the raw value. For numeric fields, omit the field if the value is blank. Send `Number(v)` if it is finite, otherwise the raw string.
      - POST with `Content-Type: application/json`.
      - On a non-2xx response, show `error.message` plus one line per `fields` entry (`field: message`) using `textContent`.
      - On success, clear the error and refresh the list.
    - Polling: `refresh()` runs every 1000 ms (and immediately at load). It fetches `/api/jobs` and rebuilds the list. Each job becomes an `<li data-testid="job-item" data-job-id=id>` containing spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`). Always use `textContent`, never innerHTML with job data.

## Behaviours to verify
- **Build and checks**: `npm run build && npm run check:smoke && npm run check:contract` must all pass.
- **Health**: start the server alone and confirm `/health` reports `worker:"down"`. Start the worker and it should report `"up"` within 1 s. Kill the worker with `kill -9` and it should be `"down"` after about 3 s.
- **Validation**: send each of the following with curl and expect 400 with the named field:
  - `steps:"3"` → `steps`
  - `steps:2.5` → `steps`
  - `failAttempts:6` → `failAttempts`
  - `input:"   "` → `input`
  - an `input` of 1001 characters → `input`
  - `{"x":1}` → `x`
  - `[]`, `null` or `{bad` → `body`
  - no Content-Type, or `text/plain` → `body` / `Content-Type`
  - `Idempotency-Key: a b` → `Idempotency-Key`

  Afterwards, `GET /api/jobs` should show the job count unchanged.
- **Idempotency**:
  - The same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 201 then 200 with the same id.
  - A different input with that key returns 409.
  - Restart the server and replay: expect 200 with the same id.
- **Progress**: with `steps:20`, poll `GET /api/jobs/:id` every 100 ms. `progress.completed` should rise step by step and end `completed` with the upper-cased output and `attempts:1`.
- **Retries**:
  - `failAttempts:2` should end `completed` with `attempts:3`.
  - `failAttempts:3` should end `failed` with `error:"transient failure"`, `result:null` and `attempts:3`.
  - The job count should stay at one.
- **Crash recovery**: submit `steps:20` and `kill -9` the worker mid-run. The job stays `running`. Restart the worker and the job should complete. Completed jobs keep their `updatedAt` unchanged.
- **SIGTERM**: send SIGTERM to each process. Both should exit promptly with code 0.
- **UI**: open `/`, submit a job and watch status and progress update without a reload. Submitting steps=50 should show `steps` in `form-error`.

## Risks
- Browser-side validation (`min`, `max`, `required`, `maxlength`) can stop the form from reaching the API, so the UI never shows the API error. Use `novalidate` and leave those attributes off.
- Do not convert numeric strings on the server, and do not accept `null` as "use the default". Only an absent field gets the default.
- Both processes open the database at the same time. Keep `busy_timeout` set before anything else, and wrap writes in short transactions. Never hold a transaction open across an `await`.
- `node:sqlite` returns rows as null-prototype objects and integers as numbers. Map them explicitly in `toJob`. Use named or positional parameters, never string interpolation.
- Imports must keep the `./db.ts` extension (`rewriteRelativeImportExtensions` is on), and the UI path must stay `new URL('../ui/index.html', import.meta.url)` so it resolves from `dist/`.
- Every API response, including 404, 405 and 500, must be JSON with the error shape. Only `GET /` returns HTML.
- Order the list by `seq DESC`, not `created_at`. Jobs created in the same millisecond would otherwise sort ambiguously.
- Do not reprocess terminal jobs. Recovery only touches `status='running'`, and every worker update is guarded with `AND status='running'`.
- Shutdown can hang on keep-alive connections or pending timers. Use `closeAllConnections()` and an unref'd forced exit.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
