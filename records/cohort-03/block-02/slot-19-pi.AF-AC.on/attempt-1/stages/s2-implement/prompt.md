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
Use one SQLite schema, shared through `src/db.ts`. It holds a `jobs` table and a single-row `worker_heartbeat` table. Both processes call an idempotent `initSchema()` on startup, so either one can start first. The server is a plain `node:http` router with strict validation. Idempotency rests on a UNIQUE `idempotency_key` column plus a stored canonical payload, and the check runs inside a `BEGIN IMMEDIATE` transaction. The worker is a polling loop. It claims the oldest runnable queued job in a transaction, runs the steps with progress writes, handles retries through an `available_at` timestamp, writes a heartbeat every 1 s, and on startup re-queues jobs left `running`. The UI is one static HTML file with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (busy_timeout + WAL). Add `initSchema(db)`, the `JobRow` type, `rowToJob(row)` (builds the API JSON shape) and `nowIso()`.
- `src/server.ts`: rewrite. Add the router, body reading, validation, idempotency, health, UI serving and SIGTERM handling.
- `src/worker.ts`: rewrite. Add the heartbeat, startup recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: the full page with the required `data-testid`s and inline script. It stays at this path because the server reads `../ui/index.html` relative to `dist/server.js`.

## Steps
1. **Schema** in `initSchema`, using `CREATE TABLE IF NOT EXISTS`:
   - `jobs`:
     - `seq INTEGER PRIMARY KEY AUTOINCREMENT`
     - `id TEXT UNIQUE NOT NULL` (`crypto.randomUUID()`)
     - `status TEXT`, `input TEXT`, `steps INT`, `fail_attempts INT`, `attempts INT DEFAULT 0`, `progress_completed INT DEFAULT 0`
     - `result_output TEXT NULL`, `error TEXT NULL`
     - `idempotency_key TEXT UNIQUE NULL`, `payload TEXT` (canonical JSON `{"input","steps","failAttempts"}` in fixed key order)
     - `available_at INTEGER` (epoch ms), `created_at TEXT`, `updated_at TEXT`
     - Index on `(status, available_at, seq)`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER)`.
   - Wrap init in try/catch-retry, or rely on `busy_timeout`. Keep the busy_timeout-before-WAL order.
2. **rowToJob**: returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total:steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
3. **Server helpers**:
   - `send(res, status, body)` always uses `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body as a Buffer, capped at about 1 MB (over the cap gives 400 with field `body`).
4. **Routing**, matched on `pathname`:
   - `/` accepts GET (HTML) only.
   - `/health` accepts GET only.
   - `/api/jobs` accepts GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` accepts GET only.
   - Any other method on a known path → 405 `method_not_allowed`. Any unknown path → 404 `not_found`.
   - Wrap the handler in try/catch → 500 `internal_error`.
5. **POST validation**: collect every error into `fields[]`, then return 400 `invalid_request` if any were found.
   - **Content-Type**: take the media type, split on `;`, trim and lowercase it. It must equal `application/json`; otherwise add a `body` error.
   - **Body**: `JSON.parse` failure, or a result that is not a plain object (null, array or primitive) → field `body`.
   - **Unknown keys** → one entry per key name.
   - **`input`**: missing, or not `typeof === 'string'`, or length 0 or over 1000, or `trim()===''` → field `input`.
   - **`steps` / `failAttempts`**: an absent key (`undefined`) takes the default. Any present value must satisfy `typeof v==='number' && Number.isInteger(v)` and be in range. Explicit `null` and `"3"` are invalid.
   - **`Idempotency-Key` header**: if present (`req.headers['idempotency-key']`), it must match `^[A-Za-z0-9_-]{1,128}$`, else field `Idempotency-Key`. Validate it together with the body.
6. **Create the job** inside `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on throw):
   - If a key was sent, `SELECT` by `idempotency_key`. If found and `payload` equals the canonical payload → 200 with that job. If found with a different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT with `status='queued'`, `attempts=0`, `progress=0`, `available_at=Date.now()` and the same ISO timestamp for created and updated. Return 201.
   - The UNIQUE constraint backs this up across restarts.
7. **GET routes**:
   - `GET /api/jobs`: `ORDER BY seq DESC` (timestamps can tie, so don't sort by them) → `{jobs}`.
   - `GET /api/jobs/:id`: `decodeURIComponent` the id, then 200 with the job or 404 `not_found`.
   - `/health`: `worker` is `'up'` if `Date.now() - last_seen <= 3000`.
8. **Server shutdown**: on SIGTERM/SIGINT call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Log once listening.
9. **Worker startup**:
   - `openDatabase`, `initSchema`, then write the heartbeat immediately.
   - `setInterval` every 1000 ms to upsert the heartbeat (`INSERT … ON CONFLICT(id) DO UPDATE`).
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, available_at=now WHERE status='running'`. The interrupted attempt is re-run under the same number, so `attempts` never goes above 3 and the failAttempts behaviour stays deterministic.
10. **Worker loop** (`while(!stopping)`):
    - **Claim** in `BEGIN IMMEDIATE`: `SELECT … WHERE status='queued' AND available_at<=? ORDER BY seq ASC LIMIT 1`, then `UPDATE SET status='running', attempts=attempts+1, progress_completed=0, updated_at`.
    - If nothing was claimed, sleep 200 ms.
    - **Process attempt n**: if `n <= fail_attempts`, sleep about 100 ms and fail with no progress write.
      - If `n < 3`: `status='queued'`, `progress_completed=0`, `available_at=now+500`.
      - Else: `status='failed'`, `error='transient failure'`, `result_output=NULL`.
    - Otherwise, for each step: sleep 100 ms, then `UPDATE progress_completed=i, updated_at`.
    - After the last step: `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`.
    - Guard every update with `WHERE id=? AND status='running'`.
11. **Worker SIGTERM**:
    - Set `stopping`. The step loop checks `stopping` after each sleep and aborts.
    - Put an aborted job back: `status='queued'`, `attempts=attempts-1`, `progress=0`.
    - `clearInterval`, `db.close()`, `process.exit(0)` within about 1 s.
12. **UI**:
    - Form `data-testid="job-form"` with `novalidate`, containing:
      - `<textarea data-testid="job-input">`
      - `<input type="text" inputmode="numeric" data-testid="job-steps" value="5">`
      - `<input … data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
      - `<div data-testid="form-error" role="alert"></div>`
      - `<ul data-testid="job-list">`
    - **Submit**: `preventDefault`. Build the body as follows:
      - `input` is the raw value.
      - For each numeric field: if blank, omit the key; if it matches `/^-?\d+(\.\d+)?$/`, send `Number(v)`; otherwise send the raw string so the API rejects it.
    - **Response handling**: POST with a JSON content type. On a non-2xx response, fill `form-error` using `textContent` with the message plus one line per field: `"<field>: <message>"`. On success, clear `form-error` and the input, then refresh.
    - **Refresh**: on load and every 1000 ms, `fetch('/api/jobs')`. Render each job as `<li data-testid="job-item" data-job-id=id>` containing `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, else `''`).
    - Use `textContent` only, never innerHTML with user data. Preserve the API's newest-first order.

## Behaviours to verify
Run `npm run build`, then `npm run check:smoke` and `npm run check:contract` (the latter covers the contract cases). Also spot-check manually with `PORT=3100 DATABASE_PATH=/tmp/t/jobs.db`:
- **Create and list**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}'` → 201, queued, attempts 0, progress 0/2. `GET /api/jobs` shows it first.
- **Validation**: `{"input":"a","steps":"2"}`, `failAttempts:7`, `colour:"blue"`, missing input, `[]`, `not json`, no content-type, `Idempotency-Key: bad key!` → each gives 400 with the right `fields[].field`, and the job count is unchanged.
- **Idempotency**:
  - The same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` → 201 then 200, same id.
  - A different input → 409.
  - Restart the server and replay → still 200, same id.
- **Processing**: watch `GET /api/jobs/:id` while the job runs. Progress increments, then completed with `HI` and attempts 1.
- **Retries**: `failAttempts:1` → completed with attempts 2. `failAttempts:2` → attempts 3, completed. `failAttempts:3` → failed, `"transient failure"`, attempts 3, result null.
- **Health**: `worker` is `up` while the worker runs. Kill the worker and it shows `down` within about 3 s.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run and restart it. The job completes. Completed jobs are untouched (`attempts` unchanged).
- **Start order and shutdown**: start the worker before the server against a fresh dir (the parent dir gets created). `kill -TERM` on each exits promptly with code 0.
- **UI**: open `/`, submit `steps=abc` → `form-error` shows "steps". A valid submit shows the item, progress ticks and the result appears.
- **404/405**: `GET /nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `POST /health` → 405.

## Risks
- **Ordering**: sorting newest-first by `created_at` ties within the same ms. Use `seq`.
- **Type checks**: `typeof null === 'object'` and `Array.isArray` both need handling. `Number.isInteger(2.0)` is true, which is acceptable. Never coerce numeric strings.
- **Recovery**: plain re-queueing would push `attempts` to 4. Decrement on recovery and on SIGTERM abort.
- **SQLite locking**: two processes write concurrently. Keep busy_timeout and use `BEGIN IMMEDIATE` for claim and create. Always COMMIT or ROLLBACK in `finally` so the connection is never left inside a transaction.
- **Heartbeat**: it must keep beating during long jobs. Use a `setInterval`, not the loop, and keep it independent of the step `await`s.
- **Imports**: `.ts` extension imports are required. `rewriteRelativeImportExtensions` is on, so keep `./db.ts`. `node:sqlite` returns rows as null-prototype objects with numbers, so cast fields explicitly. The `node:sqlite` `ExperimentalWarning` is already suppressed by the npm scripts.
- **Content type**: every response, including 404/405/500, must carry `application/json`. Only `/` returns HTML.
- **UI**: `type="number"` inputs would swallow invalid text and block API validation. Use text inputs with `novalidate`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
