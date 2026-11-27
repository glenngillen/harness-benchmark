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
Use one SQLite database with three tables: `jobs`, `idempotency_keys` and `worker_heartbeat`. The server and worker share it through `src/db.ts`, which opens the file (creating its directory), creates the schema idempotently and provides row→JSON mapping. The server is a plain `node:http` router with strict validation; all writes go through synchronous `DatabaseSync` calls inside `BEGIN IMMEDIATE` transactions. The worker is a single async loop. It claims the oldest runnable queued job in a transaction, runs its steps with sleeps, writes progress after each step, schedules retries using a `next_run_at` column, writes a heartbeat every 500 ms, and on startup re-queues any job left `running`. The UI is one static HTML file with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (busy_timeout + WAL), add `CREATE TABLE IF NOT EXISTS` schema, a shared `JobRow` type, `rowToJob()`, and `nowIso()`.
- `src/server.ts`: rewrite with routing, validation, idempotency, error helpers, `/health` from the heartbeat, and SIGTERM handling. Keep reading `../ui/index.html` relative to `import.meta.url` (works from `dist/`).
- `src/worker.ts`: rewrite with recovery, heartbeat, claim loop, step processing, retries, and SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling script.

## Steps
1. **Schema** (in `db.ts`, run by both processes; use IF NOT EXISTS so either can start first):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, next_run_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, plus an index on `(status, next_run_at, seq)`.
   - `idempotency_keys(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL)`.
2. **`rowToJob`**: returns `{id, status, input, steps, failAttempts, attempts, progress:{completed:progress,total:steps}, result: status==='completed' ? {output: result_output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Timestamps come from `new Date().toISOString()`.
3. **Server helpers**: `send(res, status, body)` always uses `application/json; charset=utf-8`. Add `sendError(res, status, code, message, fields?)`.
4. **Routing** (strip the query string):
   - `/health`: GET only.
   - `/`: GET only, serves HTML.
   - `/api/jobs`: GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/`: GET only.
   - Known path with another method → 405 `method_not_allowed`. Anything else → 404 `not_found`.
   - Wrap the handler in try/catch so unexpected errors return 500 JSON.
5. **POST validation**: read the full body as a string, then collect field errors into an array:
   - Content-Type: take the media type before `;`, trimmed and lowercased. If it is not `application/json` (or the header is missing), add a `body` error.
   - Body: `JSON.parse` in try/catch; on failure add a `body` error. If the parsed value is not a plain object (null, array or primitive), add a `body` error.
   - Unknown keys: add one error per key, using the key name as the field.
   - `input`: must be a string with `length` 1–1000 and `trim().length > 0`.
   - `steps` and `failAttempts`: if present, must be `typeof 'number'`, `Number.isInteger`, and in range. Absent means the default.
   - `Idempotency-Key`: if the header is present (including empty), it must match `^[A-Za-z0-9_-]{1,128}$`; otherwise add field `"Idempotency-Key"`.
   - If there are any errors, return 400 `invalid_request` with `fields`.
6. **Create and idempotency**: build the normalized payload `JSON.stringify({input, steps, failAttempts})` with a fixed key order. Inside `BEGIN IMMEDIATE … COMMIT` (with ROLLBACK on error):
   - If there is a key and a row exists: return 200 with the original job if `payload` matches, otherwise 409 `idempotency_conflict`.
   - Otherwise insert the job (`randomUUID()`, status `queued`, attempts 0, progress 0, `next_run_at = 0`) and the key row if one was given. Return 201.
   - The key's PRIMARY KEY guarantees one job per key, including across restarts.
7. **GET endpoints**: list uses `SELECT * FROM jobs ORDER BY seq DESC`; get-by-id returns 404 `not_found` when the job is missing.
8. **Health**: read `beat_at`; return `worker:'up'` if `Date.now() - beat_at < 3000`, otherwise `'down'` (also `'down'` when there is no row).
9. **Server SIGTERM/SIGINT**: call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a fallback `setTimeout(() => process.exit(0), 2000).unref()`.
10. **Worker startup**:
    - Open the DB and write a heartbeat immediately, then `setInterval` an upsert every 500 ms (`INSERT … ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`).
    - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, next_run_at=0, updated_at=? WHERE status='running'`. The interrupted attempt is redone, so the 3-attempt cap and the "attempt n fails if n ≤ failAttempts" rule stay consistent.
11. **Worker loop** (`while (!stopping)`):
    - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND next_run_at <= now ORDER BY seq ASC LIMIT 1`. If found, `UPDATE … SET status='running', attempts=attempts+1, progress=0, updated_at=?`, then COMMIT. If there is no job, sleep 200 ms.
    - Process the claimed job, with `n` being the new attempt number:
      - If `n <= fail_attempts`: sleep about 100 ms (it fails "at its first step"), then fail the attempt. If `n < 3`, set `status='queued'`, `next_run_at = now + 500`, progress 0. Otherwise set `status='failed'`, `error='transient failure'`, `result_output=NULL`.
      - Otherwise run `steps` iterations: `await sleep(100)`, then `UPDATE progress=i, updated_at`. Check `stopping` between steps. At the end, set `status='completed'`, `result_output=input.toUpperCase()`, `progress=steps`.
    - Guard every update with `WHERE id=? AND status='running'`.
12. **Worker SIGTERM/SIGINT**: set `stopping = true`. The loop exits at the next step boundary (≤100 ms). If a job is mid-run, re-queue it with the same recovery update as step 10. Then clear the interval, delete the heartbeat row (so health shows down quickly), call `db.close()` and `process.exit(0)`.
13. **UI (`ui/index.html`)**:
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input">` (text, no `required`/`maxlength`);
      - `<input data-testid="job-steps" value="5">` and `<input data-testid="job-fail-attempts" value="0">`, both `type="text" inputmode="numeric"` with no min/max so the browser never blocks submission;
      - `<button data-testid="job-submit" type="submit">`.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - On submit (preventDefault), build the body as `{input}`. For each numeric field: omit it if empty after trim, send `Number(v)` if `v.trim() !== '' && Number.isFinite(Number(v))`, otherwise send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`.
    - If the response is not ok, set form-error to `error.message` plus one line per field (`field: message`).
    - If it is ok, clear form-error, reset the input, and refresh immediately.
    - Poll `/api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>` with spans `job-status`, `job-progress` (`${c}/${t}`) and `job-result` (output if completed, error if failed, else ''). Use `textContent` only. Keep the server's newest-first order.
14. Run `npm run build`, start both processes, and run `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and start**: `npm run build && DATABASE_PATH=/tmp/t/x.db PORT=3100 npm run start:server` creates `/tmp/t`. Start the worker in either order.
- **Health**: `curl :3100/health` shows `up` with the worker running. Within 3 s of `kill -9` on the worker it shows `down`.
- **Validation**: send each of these with curl and expect 400 `invalid_request` with the right field:
  - `{"input":"a","steps":"2"}` → `steps`;
  - `failAttempts:7` → `failAttempts`;
  - `colour` → `colour`;
  - missing input → `input`;
  - `"   "` input → `input`;
  - `[1]` → `body`;
  - bad JSON → `body`;
  - `text/plain` → `body`;
  - `Idempotency-Key: bad key!` → `Idempotency-Key`.
  
  Then check that the job count is unchanged.
- **Idempotency**: POST with key K returns 201. The same payload, with explicit defaults, returns 200 with the same id. A different input returns 409. Restart the server and repeat: still 200 and still one job.
- **Progress**: `steps:10`; poll `GET /api/jobs/:id` and see `progress.completed` rise while the status is `running`.
- **Retries**:
  - `failAttempts:1, steps:1` → completed, attempts 2.
  - `failAttempts:2` → completed, attempts 3.
  - `failAttempts:3` → failed, attempts 3, error `"transient failure"`, result null.
  - Only one job is listed in each case.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it, and check the job completes. Completed jobs keep `attempts` unchanged after restarts.
- **Ordering**: list is newest first. The worker processes jobs oldest first.
- **Unknown routes**: `/nope` → 404 `not_found`; `DELETE /api/jobs` → 405; `GET /api/jobs/xyz` → 404.
- **SIGTERM**: `kill -TERM` exits each process promptly with code 0.
- **UI**: open `/`, submit `steps` 50 and see form-error mention `steps`. Submit a valid job and watch status and progress update without reloading.

## Risks
- **Browser validation blocking submission**: `type=number` with min/max, or `required`, can stop the form before the API sees it, so form-error never fills. Use `novalidate` and text inputs.
- **Wrong timestamp ordering**: sorting by `created_at` can tie within the same millisecond. Order by `seq`.
- **Wrong Content-Type**: every JSON response, including 404/405/500, must be `application/json`. Only `/` returns HTML.
- **Validation gaps**: numeric strings must be rejected; check `typeof === 'number'`, never coerce. An empty `Idempotency-Key` header counts as present and invalid.
- **Lock errors**: write contention between processes raises SQLITE_BUSY. Keep busy_timeout, keep transactions short, and never hold one across an `await`.
- **Retry delay**: it must be 250 ms–2 s. Use 500 ms via `next_run_at`, not a sleep that blocks other jobs. The polling interval (200 ms) keeps idle pickup under 1 s.
- **Attempt cap after a crash**: recovering a job killed during attempt 3 must not push it to attempt 4. The `attempts-1` re-queue handles this.
- **Graceful shutdown hangs**: keep-alive sockets and the heartbeat interval can keep the process alive. Use `closeAllConnections` and explicit `process.exit(0)`.
- **XSS**: job input is user text. Use `textContent`, never `innerHTML`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
