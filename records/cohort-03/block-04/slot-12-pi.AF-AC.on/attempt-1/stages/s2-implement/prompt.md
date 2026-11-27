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
Use one SQLite schema, created idempotently by `openDatabase()` in both processes. It holds a `jobs` table (autoincrement `seq` for ordering, UUID `id`, and a unique nullable `idempotency_key` with its canonical payload) and a single-row `heartbeat` table. The server is a plain `node:http` router with strict validation. Idempotency is enforced inside a `BEGIN IMMEDIATE` transaction backed by the UNIQUE constraint. The worker is a polling loop that claims the oldest eligible queued job in a transaction, runs its steps with `await sleep(100)`, and writes progress after each step. A separate interval writes the heartbeat. Crash recovery happens at worker startup: any `running` job goes back to `queued`. The UI is a single static HTML file with vanilla JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for the schema, plus shared helpers: the `JobRow` type, `rowToJob(row)` that builds the API shape, and `nowIso()`.
- `src/server.ts`: router, body reading, validation, idempotency, health, SIGTERM handling.
- `src/worker.ts`: heartbeat, recovery, claim/process loop, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling script. The server already loads it from `../ui/index.html` relative to `dist/server.js`; keep that.

## Steps
1. **Schema** in `db.ts`, run on every open:
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT,
     next_run_at INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
   ```
   `rowToJob` returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Use `new Date().toISOString()` for timestamps. Keep the `.ts` extension in relative imports, because tsconfig rewrites them.
2. **Server helpers**: `send(res, status, body)` always sets `application/json; charset=utf-8`. Add `sendError(res, status, code, message, fields?)`.
3. **Routing** on `pathname`:
   - `/` GET → HTML.
   - `/health` GET.
   - `/api/jobs` GET or POST.
   - `/api/jobs/:id` (regex `^/api/jobs/([^/]+)$`) GET.
   - A known path with the wrong method → 405 `method_not_allowed`.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **Health**: `SELECT at FROM heartbeat WHERE id=1`. `worker` is `"up"` if the row exists and `Date.now()-at < 3000`.
5. **POST validation**. Collect `fields[]` and do not stop at the first error:
   - Read the full body as a utf8 string.
   - Content-Type: missing, or its media type (before `;`, trimmed, lowercased) is not `application/json` → field `body`.
   - `Idempotency-Key` header present but failing `/^[A-Za-z0-9_-]{1,128}$/` → field `Idempotency-Key`. Validate this alongside the body errors.
   - If Content-Type is OK: `JSON.parse` in try. On failure → `body`. If the result is not a plain object (`null`, array, primitive) → `body`.
   - If it is an object: any key outside `input`, `steps`, `failAttempts` → that key's name.
   - `input` must be `typeof 'string'`, `length` 1–1000, and `trim().length > 0`. Store it untrimmed.
   - `steps` and `failAttempts`, if present (`!== undefined`), must be `typeof 'number' && Number.isInteger && in range`. Otherwise the field errors. Defaults are 5 and 0. `null` is invalid.
   - If any errors → 400 `{error:{code:'invalid_request', message:'Invalid request', fields}}`.
6. **Creation and idempotency**: `payload = JSON.stringify({input, steps, failAttempts})` (fixed key order). Inside `BEGIN IMMEDIATE … COMMIT`, with ROLLBACK on error:
   - If there is a key and a row has that key: same `payload` → 200 with that job, otherwise 409 `idempotency_conflict`.
   - Otherwise INSERT with `id=randomUUID()`, `status='queued'`, `next_run_at=0`, then return 201.
   - Store `idempotency_key` NULL when the header is absent.
7. **List and get**: `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs}`. Get by id → 200, or 404 `not_found`.
8. **Server shutdown**: on SIGTERM/SIGINT, `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`.
9. **Worker startup**:
   - Open the db.
   - Write the heartbeat immediately (`INSERT … ON CONFLICT(id) DO UPDATE SET at=excluded.at`), then every 500 ms via `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, next_run_at=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run under the same number, so `attempts` never goes above 3 and pass/fail stays deterministic. Log `worker started`.
10. **Worker loop**, `while (!stopping)`:
    - Claim inside `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND next_run_at<=? ORDER BY seq LIMIT 1`. If a row is found, `UPDATE … SET status='running', attempts=attempts+1, progress=0, updated_at=? WHERE id=?`, then COMMIT.
    - No job → `await sleep(200)`.
    - Process with `n = attempts` (after the increment):
      - If `n <= fail_attempts`: `await sleep(100)`. Then, if `n >= 3`, set `status='failed', error='transient failure', result_output=NULL`. Otherwise set `status='queued', progress=0, next_run_at=Date.now()+500`.
      - Otherwise, for i in 1..steps: `await sleep(100)`. If `stopping`, abort (see step 11). Then `UPDATE progress=i, updated_at`.
      - At the end: `status='completed', result_output=input.toUpperCase(), progress=steps`.
    - Put `AND status='running'` on all of these updates.
11. **Worker shutdown**: SIGTERM/SIGINT sets `stopping=true`. If a job is mid-flight, put it back the same way recovery does (queued, `attempts-1`, progress 0). Then `clearInterval`, optionally `DELETE FROM heartbeat`, `db.close()`, `process.exit(0)`. The worker must exit well within 5 s; a step is at most 100 ms.
12. **UI** (`ui/index.html`):
    - Markup:
      - `<form data-testid="job-form" novalidate>`.
      - `<input data-testid="job-input">`.
      - `<input type="text" inputmode="numeric" data-testid="job-steps" value="5">`.
      - `<input type="text" inputmode="numeric" data-testid="job-fail-attempts" value="0">`.
      - `<button type="submit" data-testid="job-submit">`.
      - `<div data-testid="form-error" role="alert"></div>`.
      - `<ul data-testid="job-list">`.
    - Submit handler: call `preventDefault`. Build the body with `input` as the raw value. For each numeric field: empty → omit it; else `n=Number(v.trim())`, send `n` if `Number.isFinite(n)`, otherwise send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, fill `form-error` via `textContent`/DOM nodes: the message plus one line per `fields` entry (`field: message`).
    - On success, clear `form-error`, clear the input, and refresh immediately.
    - `refresh()` fetches `/api/jobs` every 1000 ms. For each job it renders `<li data-testid="job-item" data-job-id=id>`, containing spans `job-status` (status), `job-progress` (`${completed}/${total}`), and `job-result` (`result.output`, or `error`, or empty), plus the input text.
    - Use `textContent` only; never innerHTML with user data.

## Behaviours to verify
- Build/run: `npm run build && npm run check:smoke && npm run check:contract`. Both must pass.
- Health: start only the server → `worker:"down"`. Start the worker → `"up"` within 1 s. Kill the worker → `"down"` after about 3 s.
- Validation: with curl, test `steps:"3"`, `steps:2.5`, `steps:0`, `failAttempts:6`, an unknown field, `input:"   "`, an input of 1001 chars, the body `[]`, the body `{bad`, a missing Content-Type, `text/plain`, and `Idempotency-Key: a b`. Each must give 400 with the right `fields[].field` and leave the job count unchanged.
- Defaults and idempotency: POST `{"input":"a"}` with key K → 201. Then `{"input":"a","steps":5,"failAttempts":0}` with K → 200 with the same id. Then `{"input":"b"}` with K → 409. Restart the server and replay → still 200, same id.
- Progress: POST `steps:20` and poll `GET /api/jobs/:id` every 150 ms. You should see `running` with increasing `progress.completed`, then `completed` with output `INPUT`.
- Retries: `failAttempts:1` → completed, attempts 2. `failAttempts:2` → completed, attempts 3. `failAttempts:3` → failed, attempts 3, `error:"transient failure"`, `result:null`.
- Crash recovery: POST `steps:20`, then `kill -9` the worker while the job is running. Status stays `running`. Restart the worker → the job completes within a few seconds and `attempts` is 1. Completed jobs are untouched.
- SIGTERM: `kill -TERM` each process. Each exits 0 promptly.
- UI: open `/`, submit a valid job and watch status/progress update without reload. Submit steps `abc` or `99` → `form-error` shows `steps`.

## Risks
- **npm signal wrapping**: `npm run` wraps node, and the check runner signals the process group, so handlers must call `process.exit(0)` and not hang on open handles (the interval, keep-alive sockets). Use `closeAllConnections()`.
- **SQLITE_BUSY between processes**: keep `busy_timeout`. Use `BEGIN IMMEDIATE` for claim and create. Never hold a transaction open across an `await`.
- **Ordering ties**: equal `createdAt` values in the same millisecond can break "newest first". Order by `seq`, not by `created_at`.
- **Attempt counting**: retry delays must keep the job `queued` with `next_run_at`, not sleep while still `running`. Recovery must not push `attempts` past 3; that is why it decrements.
- **Validation edge cases**: `typeof NaN === 'number'`, but JSON can't produce NaN, so `Number.isInteger` is enough. Reject `null` values and arrays as bodies. Content-Type `application/json; charset=utf-8` must be accepted.
- **Browser validation in the UI**: `type=number` with min/max would let the browser block a submission before it reaches the API, and Playwright can't fill non-numeric text into it. Use text inputs with `novalidate`.
- **Unexpected exceptions**: return JSON 500 rather than crashing. Use `rowToJob` everywhere so all endpoints return the same shape.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
