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
Keep the three existing modules: `src/db.ts` holds the shared schema and data access, `src/server.ts` is the HTTP API plus the UI, and `src/worker.ts` is the polling worker. Add `src/validate.ts`, which holds pure validation and idempotency normalization. All state lives in SQLite: a `jobs` table and a `worker_heartbeat` table. Every multi-statement change runs inside `BEGIN IMMEDIATE` so both processes stay consistent. The worker writes a heartbeat every 500 ms on its own interval timer. It claims one due queued job at a time (oldest first), runs steps with `await sleep(100)`, writes progress after each step, and puts any `running` jobs back in the queue when it starts. The UI is a single static `ui/index.html` with inline JS that polls `GET /api/jobs` every 1 s.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` schema, a row→job mapper, and data functions: `createJob`, `getJob`, `listJobs`, `claimNextJob`, `updateProgress`, `completeJob`, `failAttempt`, `recoverRunning`, `writeHeartbeat`, `readHeartbeat`.
- `src/validate.ts` (new): `validateSubmission(contentType, rawBody, idemKey)` returns `{ok, payload}` or `{ok:false, fields}`.
- `src/server.ts`: router, JSON error helpers, body reading, idempotent create, health check, SIGTERM handling.
- `src/worker.ts`: heartbeat timer, recovery at startup, claim/process loop, retry scheduling, SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling script.

## Steps
1. **Schema** (in `db.ts`, run by both processes; it is idempotent):
   - `jobs`:
     - `seq INTEGER PRIMARY KEY AUTOINCREMENT`
     - `id TEXT UNIQUE NOT NULL` (from `crypto.randomUUID()`)
     - `status TEXT`, `input TEXT`, `steps INT`, `fail_attempts INT`
     - `attempts INT DEFAULT 0`, `progress INT DEFAULT 0`
     - `output TEXT NULL`, `error TEXT NULL`
     - `run_after INTEGER` (epoch ms)
     - `idem_key TEXT UNIQUE NULL`, `idem_payload TEXT NULL`
     - `created_at TEXT`, `updated_at TEXT` (ISO)
   - Index on `(status, run_after, seq)`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER)`.
   - Concurrent startup: wrap schema creation in try/catch with a retry, or rely on busy_timeout (5000 is already set).
2. **Job mapper**: build the exact shape `{id,status,input,steps,failAttempts,attempts,progress:{completed,total:steps},result: status==='completed'?{output}:null, error: status==='failed'?error:null, createdAt, updatedAt}`.
3. **Validation** (`validate.ts`), collecting every field error:
   - Content-Type: missing, or media type (before `;`, trimmed, lowercased) not `application/json` → field `body`.
   - `JSON.parse` failure → `body`. Result null, an array, or not an object → `body`.
   - Unknown keys → one entry per key.
   - `input`: must be a string, `length` 1–1000, and `input.trim() !== ''`. Store it untrimmed.
   - `steps` / `failAttempts`: if the key is present (even with value `null`), require `typeof === 'number' && Number.isInteger(v)` and the range check. Absent → default.
   - Idempotency-Key header present and not matching `/^[A-Za-z0-9_-]{1,128}$/` → field `Idempotency-Key`.
   - Normalized payload is `JSON.stringify({input, steps, failAttempts})` in a fixed key order.
4. **Server routing**: parse the pathname. Known paths are `/`, `/health`, `/api/jobs` and `/api/jobs/:id` (one segment, decoded). Allowed methods are GET on `/`, `/health` and `/api/jobs/:id`, and GET+POST on `/api/jobs`. Known path with wrong method → 405 `method_not_allowed`. Anything else → 404 `not_found`. Wrap the handler in try/catch and return 500 `internal_error` JSON on failure. Read the body as a Buffer and decode it as UTF-8.
5. **POST create** (in one `BEGIN IMMEDIATE` transaction):
   - If a key is given, `SELECT` by `idem_key`.
     - Found with equal `idem_payload` → COMMIT and return 200 with that job.
     - Found with a different payload → 409 `idempotency_conflict`.
     - Otherwise insert with `status='queued'`, `run_after=0`, and return 201.
   - Use try/finally to ROLLBACK on error. As a backstop, if the UNIQUE constraint fails, re-select and apply the same comparison.
6. **GET list / get**: `ORDER BY seq DESC` for newest first. Unknown id → 404 `not_found`. All JSON responses use `application/json; charset=utf-8`.
7. **Health**: `worker = Date.now() - beat_at < 3000 ? 'up' : 'down'`. A missing row means down.
8. **Worker start**:
   - Open the DB and write a heartbeat immediately, then `setInterval(writeHeartbeat, 500)`.
   - `recoverRunning()`: `UPDATE jobs SET status='queued', progress=0, attempts=MAX(attempts-1,0), run_after=0, updated_at=now WHERE status='running'`. The interrupted attempt is un-counted so the 3-attempt cap and the attempt numbering for `failAttempts` stay correct. Run this before the loop starts. The worker is single, so it is safe.
9. **Worker loop** (while `!stopping`):
   - Claim in one IMMEDIATE transaction: `SELECT ... WHERE status='queued' AND run_after<=now ORDER BY seq LIMIT 1`, then `UPDATE` it to `status='running', attempts=attempts+1, progress=0, updated_at`.
   - Nothing claimed → `sleep(200)`.
   - Attempt n = new `attempts`. If `n <= fail_attempts`:
     - `n >= 3` → `status='failed'`, `error='transient failure'`, `output=NULL`.
     - Otherwise → `status='queued'`, `progress=0`, `run_after=now+500`.
   - Else, for each step: `await sleep(100)`, then `UPDATE progress=i`. Finally set `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
   - Every terminal or progress write includes `WHERE id=? AND status='running'`.
10. **Worker SIGTERM**: set `stopping`. Mid-job, either finish the current step and leave the job `running` (recovery requeues it), or simply exit. Then clear the interval, `db.close()` and `process.exit(0)` within about 1 s. A simple approach: on signal, clear the interval, close the db, and exit immediately. The job stays running and gets recovered.
11. **Server SIGTERM/SIGINT**: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`, plus a fallback `setTimeout(...).unref()`.
12. **UI**:
    - `<form data-testid="job-form">` containing:
      - `input[data-testid=job-input]` (text)
      - `input[type=number][data-testid=job-steps]` (value 5)
      - `input[type=number][data-testid=job-fail-attempts]` (value 0)
      - `button[data-testid=job-submit]`
    - `<div data-testid="form-error" role="alert"></div>`
    - `<ul data-testid="job-list">`
    - On submit, call `preventDefault`. Build the body with `input` as the raw string. For each numeric field, a blank value omits the key; otherwise send `Number(value)`. If `Number(value)` is NaN, send the raw string so the API rejects it. Do not put `required`, `min` or `max` on the fields, and set `novalidate` on the form, so invalid values reach the API.
    - POST with `Content-Type: application/json`.
    - Not ok → set the error region's text to `error.message` plus each `field: message`.
    - Ok → clear the error region and refresh.
    - Poll `GET /api/jobs` every 1000 ms. Render `li[data-testid=job-item][data-job-id]` items containing:
      - `span[data-testid=job-status]`
      - `span[data-testid=job-progress]` showing `c/t`
      - `span[data-testid=job-result]` showing the output, or the error text, or empty
    - Use `textContent` only (never innerHTML) for user data.

## Behaviours to verify
- Build and run: `npm run build && npm run check:smoke && npm run check:contract`; both suites must pass.
- Health: start only the server → `worker: down`. Start the worker → `up` within 1 s. Kill the worker → `down` after about 3 s.
- Validation: use curl to send `{"input":"a","steps":"3"}`, `{"input":"   "}`, `{"x":1,"input":"a"}`, a malformed body, `[]`, no Content-Type, `text/plain`, `steps:1.5`, `steps:21`, `failAttempts:6`, and the header `Idempotency-Key: bad key`. Each should return 400 with the right `fields`, and `GET /api/jobs` should not grow.
- Idempotency: POST `{"input":"a"}` with key K → 201. Repeat with `{"input":"a","steps":5,"failAttempts":0}` → 200 with the same id. Send `{"input":"b"}` with K → 409. Restart the server and repeat → still 200.
- Progress: POST `steps:20` and poll the job; `progress.completed` increases while the status is `running`.
- Retries: `failAttempts:2` → completed with attempts 3. `failAttempts:3` → failed, `error` set to `"transient failure"`, attempts 3, result null.
- Crash recovery: submit `steps:20`, `kill -9` the worker mid-run, restart it → the job completes. Completed jobs keep their `updatedAt` unchanged across restarts.
- Routing: `DELETE /api/jobs` → 405; `GET /nope` → 404; `GET /api/jobs/xyz` → 404 `not_found`.
- UI: open `/`, submit a job, watch the status and progress update. Submit `steps` 50 → `form-error` mentions `steps`.

## Risks
- **Node 22 `node:sqlite` API**: use `db.prepare(sql).get/all/run`. Named params need the `$name` or `:name` syntax; positional `?` is simpler. A `get` with no row returns `undefined`. Values come back as number or string.
- **Imports**: keep `.ts` import extensions, which `rewriteRelativeImportExtensions` turns into `.js`. The UI path `../ui/index.html` resolves relative to `dist/`, which works.
- **Non-integer numbers**: `typeof true`, `NaN` and `Infinity` can't come from JSON, but booleans and `null` can. Reject both via the `typeof` check. Never coerce strings.
- **Duplicate jobs from idempotency races**: avoid them with the UNIQUE column plus the transaction. Never compare raw bodies; compare the normalized payload.
- **Heartbeat starvation**: the heartbeat must not depend on the job loop. Use `setInterval`. Steps are async sleeps, so the timer still fires.
- **Lock contention**: DB-locked errors are possible. busy_timeout covers most cases. Keep transactions short and never `await` inside one.
- **Attempt count after a crash**: blindly re-claiming after a crash during attempt 3 would push `attempts` to 4. The decrement in recovery prevents that.
- **Shutdown**: SIGTERM is sent to the npm process group. Both processes must exit promptly. Don't leave intervals or keep-alive sockets holding the event loop open; use `closeAllConnections` and `process.exit`.
- **UI fields**: HTML `min`/`max`/`required` would block submission, so omit them. `form-error` must be empty (not whitespace text) when there is no error.
- **Job ordering**: `seq` gives deterministic oldest-first and newest-first ordering. Don't rely on ISO timestamps, because they tie within the same millisecond.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
