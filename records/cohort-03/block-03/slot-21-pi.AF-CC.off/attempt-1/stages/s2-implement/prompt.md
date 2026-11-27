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
Keep the current layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (node:http API plus the static UI), `src/worker.ts` (polling loop), and `ui/index.html` (one page with an inline script). SQLite is the only link between the two processes. It holds a `jobs` table with a scheduling column `next_run_at` and a unique `idempotency_key`, plus a one-row `worker_heartbeat` table. The worker polls about every 200 ms for the oldest due queued job. It claims the job inside a `BEGIN IMMEDIATE` transaction, runs the steps with a database update after each one, and handles retries by setting the job back to `queued` with a future `next_run_at`. When the worker starts, it puts any job left `running` by a crash back in the queue.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for both tables. Add a `rowToJob(row)` serializer and a `nowIso()` helper. Export a `tx(db, fn)` helper that runs `BEGIN IMMEDIATE` … `COMMIT`, or `ROLLBACK` if an error is thrown.
- `src/server.ts`: routing, validation, idempotency, error shape, `/health`, `/`, SIGTERM handling.
- `src/worker.ts`: heartbeat, recovery, claim/process loop, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, and polling script, with every required `data-testid`.

## Steps
1. **Schema** (in db.ts, run by both processes at startup):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_run_at INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, idempotency_payload TEXT)`.
   Also `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen_ms INTEGER NOT NULL)`.
   `rowToJob` returns exactly the shape in the task. `result` is `{output}` only when `status='completed'`, otherwise null. `error` is non-null only when the job is failed. `progress` is `{completed: progress_completed, total: steps}`. Ids come from `crypto.randomUUID()`. Timestamps come from `new Date().toISOString()`.
2. **Server helpers**: `send(res, status, body)` always sets `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)` produces the error shape.
3. **Routing**: match on `new URL(req.url,'http://x').pathname`.
   - `/health`: GET only.
   - `/`: GET only, serves the HTML.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/<id>` (exactly one segment, run through `decodeURIComponent` inside try/catch): GET only.
   - A known path with the wrong method returns 405 `method_not_allowed` with an `Allow` header. Anything else returns 404 `not_found`.
   - Wrap the handler in try/catch so unexpected errors return 500 `internal_error`.
4. **`/health`**: read `last_seen_ms`. Return `worker: 'up'` if `Date.now() - last_seen_ms <= 3000`, otherwise `'down'`. A missing row also counts as down.
5. **POST validation**: collect every error into `fields[]` and return them all in one 400 `invalid_request`.
   - **Idempotency-Key**: if the header is present and does not match `^[A-Za-z0-9_-]{1,128}$`, add field `"Idempotency-Key"`.
   - **Content-Type**: parse the media type (`split(';')[0].trim().toLowerCase()`). If it is missing or not `application/json`, add fields `"body"` and `"Content-Type"`, then skip body parsing.
   - **Body**: read it with a cap of about 1 MB (over the cap counts as a `body` error). If `JSON.parse` throws, add a `body` error. If the result is not a plain object (null, an array, or a primitive), add a `body` error.
   - **Unknown keys**: add one field entry per key that is not `input`, `steps` or `failAttempts`.
   - **input**: must be a string with `1 <= length <= 1000` and `input.trim().length > 0`. Store it unmodified.
   - **steps and failAttempts**: if absent (`undefined`), apply the default. If present, the value must satisfy `typeof v === 'number' && Number.isInteger(v)` and fall within range. This rejects `null`, `"3"`, `2.5` and booleans.
6. **Creating jobs and idempotency**: build the canonical payload `JSON.stringify({input, steps, failAttempts})` after defaults are applied. Inside `tx`:
   - If a key was sent, `SELECT` the row with that `idempotency_key`. If the stored `idempotency_payload` equals the canonical payload, return 200 with that job. If it differs, return 409 `idempotency_conflict`.
   - Otherwise `INSERT` a row with status `queued`, attempts 0, `next_run_at=0`, the key and the payload, then return 201.
   - The UNIQUE constraint backs this up across processes and restarts. If a UNIQUE error is caught anyway, re-run the lookup.
7. **GET endpoints**: `GET /api/jobs` returns `SELECT * FROM jobs ORDER BY seq DESC`, so newest comes first. `GET /api/jobs/:id` returns the job, or 404 `not_found`.
8. **Server shutdown on SIGTERM/SIGINT**: call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a fallback timer that forces the exit.
9. **Worker startup**:
   - Open the database and run the schema.
   - Write the heartbeat right away with `INSERT … ON CONFLICT(id) DO UPDATE`, then repeat every 1000 ms from a `setInterval`. node:sqlite is synchronous and the loop awaits sleeps, so the interval keeps firing.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, next_run_at=0, updated_at=? WHERE status='running'`. The interrupted attempt is not counted, so the re-run keeps the same attempt number, `attempts` never goes above 3, and the `failAttempts` rule still applies to it.
10. **Worker loop** (`while (!stopping)`):
    - **Claim** inside `tx`: `SELECT … WHERE status='queued' AND next_run_at <= now ORDER BY seq ASC LIMIT 1`, then `UPDATE status='running', attempts=attempts+1, progress_completed=0, updated_at`. If nothing is due, sleep 200 ms.
    - **Process** with `n = attempts`. For each step `i = 1..steps`: sleep 100 ms, and return early if `stopping`.
      - If `i === 1 && n <= fail_attempts`, the attempt fails. If `n < 3`, set `status='queued'`, `progress_completed=0`, `next_run_at=Date.now()+500`. Otherwise set `status='failed'`, `error='transient failure'`, `result_output=NULL`.
      - Otherwise set `progress_completed=i`.
    - **Finish**: after the last step, set `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`.
    - Put `AND status='running'` in every update's WHERE clause for safety, and always set `updated_at`.
11. **Worker SIGTERM/SIGINT**: set `stopping`. If a job is in progress, put it back in the queue the same way recovery does (attempts−1, queued). Then clear the interval, `db.close()`, and `process.exit(0)`. A SIGKILL is covered by the recovery step on the next start.
12. **UI** (`ui/index.html`):
    - **Form**: `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input data-testid="job-steps" type="text" inputmode="numeric" value="5">`
      - `<input data-testid="job-fail-attempts" type="text" inputmode="numeric" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - **Error region**: `<div data-testid="form-error" role="alert"></div>`. **List**: `<ul data-testid="job-list">`.
    - **On submit**: call `preventDefault`. A numeric field matching `/^-?\d+(\.\d+)?$/` after trimming is sent as `Number(v)`. An empty field is omitted. Any other text is sent as the raw string so the API rejects it. `input` is sent as is. POST with `Content-Type: application/json`.
      - On a non-2xx response, show `error.message` plus one line per field entry, `"<field>: <message>"`, using textContent.
      - On success, clear the error region and refresh the list immediately.
    - **Rendering**: poll `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>`. Inside it, show the input, `<span data-testid="job-status">`, `<span data-testid="job-progress">completed/total</span>`, and `<span data-testid="job-result">`. The result span shows the output when completed, the error when failed, and is empty otherwise. Use textContent only, never innerHTML with user data.

## Behaviours to verify
- Build and the provided checks: `npm run build && npm run check:smoke && npm run check:contract`.
- Health: start only the server and expect `worker:"down"`. Start the worker and expect `"up"` within about 1 s. Kill the worker and expect `"down"` after about 3 s.
- Validation: with curl, send `steps:"3"`, `steps:2.5`, `steps:21`, `failAttempts:7`, an unknown key, `input:"   "`, a 1001-character input, malformed JSON, `[]`, `"x"`, no Content-Type, `text/plain`, and `Idempotency-Key: bad key!`. Each should return 400 with the expected field, and the job count should stay the same.
- Idempotency: send `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` with the same key, and expect 201 then 200 with the same id. A different input with that key should return 409. Restart the server and replay: still 200 with the same id.
- Progress: send `steps:20` and poll `GET /api/jobs/:id`. `progress.completed` should rise step by step.
- Retries: `failAttempts:2` should finish completed with attempts 3. `failAttempts:3` should finish failed with `error:"transient failure"`, attempts 3 and result null. Only one job should exist in each case.
- Crash recovery: start a `steps:20` job, `kill -9` the worker mid-run, and restart it. The job should complete and all jobs should still be listed. Restarting again must not reprocess completed jobs.
- SIGTERM: both processes exit with code 0 quickly.
- UI: open `/` and submit a valid job. Status and progress should update without a reload. Submit `steps` of 25 and the alert should mention `steps`.
- Routes: `DELETE /api/jobs` returns 405. `GET /nope` and `GET /api/jobs/x/y` return 404 JSON.

## Risks
- **Browser validation blocking the API error**: number inputs with min/max, or a form without `novalidate`, would stop the request from being sent, so `form-error` would never show the API's rejection. Use text inputs and `novalidate`.
- **Locking between processes**: concurrent writes can raise SQLITE_BUSY. Keep busy_timeout and WAL, keep transactions short, and use `BEGIN IMMEDIATE` for any read-then-write.
- **Ordering**: `created_at` can tie within the same millisecond. Order by `seq` instead.
- **Treating `null` as absent**: `"steps": null` must be rejected. Only `undefined` gets the default.
- **Wrong runtime paths**: `dist/server.js` must read `../ui/index.html` relative to `import.meta.url`, as it does now. Keep the `.ts` import extensions, because tsconfig rewrites them.
- **Requeue bookkeeping**: forgetting `progress_completed=0` or `next_run_at` on a requeue breaks progress reporting and retry timing. The retry delay must be between 250 ms and 2 s; use 500 ms.
- **Heartbeat stalls**: the heartbeat must not be blocked by long synchronous work. Steps must use async sleeps, never busy loops.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
