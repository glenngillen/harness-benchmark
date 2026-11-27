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
Keep the existing layout: `src/db.ts` handles the shared schema and data access, `src/server.ts` is the `node:http` API plus static UI, `src/worker.ts` is a polling worker loop, and `ui/index.html` is a self-contained page with inline JS. All state lives in SQLite through `node:sqlite` `DatabaseSync`. This includes a `jobs` table (with a scheduled `run_after` time for retries, plus an idempotency key and canonical payload) and a `worker_heartbeat` row. The worker claims jobs inside `BEGIN IMMEDIATE` transactions. It updates progress after each step, and when it starts it re-queues any job left `running` by a crashed worker. The server is synchronous against SQLite, so idempotent create (lookup, then insert) runs inside one transaction and a UNIQUE index on the key backs it up.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `migrate(db)` with `CREATE TABLE IF NOT EXISTS`. Add a row→JSON `toJob()` mapper and shared helpers (`nowIso`, the heartbeat key).
- `src/server.ts`: rewrite. Routing, validation, idempotency, error shape, health, UI serving, SIGTERM shutdown.
- `src/worker.ts`: rewrite. Heartbeat, crash recovery, claim loop, step processing, retries, SIGTERM shutdown.
- `ui/index.html`: form, error region and job list with all required `data-testid`s, plus a 1 s polling renderer.

## Steps
1. **Schema** (`migrate`, called by both processes at startup; safe to run concurrently because of IF NOT EXISTS and busy_timeout):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE, payload TEXT);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_ms INTEGER NOT NULL);
   ```
   `toJob(row)` returns exactly the JSON shape in the task. `result` is `{output}` only when status is `completed` (else null). `error` is null unless status is `failed`. `progress` is `{completed: progress_completed, total: steps}`. Order newest first with `ORDER BY seq DESC`, because createdAt can tie.
2. **Server helpers**: `send(res, status, body)` always sets `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)`. Read the body as a Buffer with a size cap (e.g. 1 MB; if exceeded, return 400 with field `body`).
3. **Routing** (parse with `new URL`, ignore the query string):
   - `/` GET serves the HTML.
   - `/health` GET.
   - `/api/jobs` GET or POST.
   - `/^\/api\/jobs\/([^/]+)$/` GET (decodeURIComponent inside try).

   A known path with any other method returns 405 `method_not_allowed`. Everything else returns 404 `not_found`. A missing job id returns 404 `not_found`. Wrap the handler in try/catch and return 500 `internal_error` JSON.
4. **Health**: `SELECT beat_ms FROM worker_heartbeat WHERE id=1`. Return `worker: "up"` if `Date.now() - beat_ms < 3000`.
5. **POST validation**: collect `fields[]` and don't stop at the first error.
   - Content-Type: parse the media type before `;`, lowercase it, and require `application/json`. If it's wrong or missing, add `{field:"body"}` and skip body parsing.
   - Idempotency-Key header present but not matching `^[A-Za-z0-9_-]{1,128}$`: add `{field:"Idempotency-Key"}`.
   - `JSON.parse`. On a throw, add `body`. If the value is not a plain object (null, array or primitive), add `body`.
   - Each key not in {input, steps, failAttempts} is reported under its own name.
   - `input`: must be a string with `1 ≤ length ≤ 1000` and `input.trim() !== ''`. Missing input gets field `input`.
   - `steps` and `failAttempts`: if present they must be `typeof === 'number' && Number.isInteger(v)` and within range. Absent means the default (5 or 0). Treat explicit `null` as invalid.
   - If any field failed, return 400 `invalid_request` with message "Invalid request" and the `fields` list.
6. **Create**: build the canonical payload with fixed key order, `JSON.stringify({input, steps, failAttempts})`. In `BEGIN IMMEDIATE … COMMIT` (ROLLBACK on error):
   - If a key was given, `SELECT * FROM jobs WHERE idempotency_key=?`. If a row exists and its payload equals the new payload, return 200 with that job. If the payload differs, return 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = crypto.randomUUID()`, status `queued`, attempts 0, `created_at = updated_at = new Date().toISOString()`, `run_after = 0`, and the key and payload (key NULL if absent). Return 201.
7. **Server shutdown**: on SIGTERM/SIGINT call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`, with a 2 s fallback exit. Log `server listening on ${port}` once listening.
8. **Worker startup**: open the DB, migrate, write the heartbeat right away (`INSERT … ON CONFLICT(id) DO UPDATE SET beat_ms=excluded.beat_ms`), then repeat it with `setInterval` every 1000 ms (`unref` not needed; clear it on shutdown). Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. Decrementing counts the interrupted attempt as not counted, so `attempts` never goes above 3. Only one worker exists, so any `running` row is orphaned.
9. **Claim** (poll every ~200 ms while idle): in `BEGIN IMMEDIATE`, run `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq ASC LIMIT 1`. If a row is found, `UPDATE … SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`, then COMMIT.
10. **Process attempt** with `n` = the new attempts value:
    - If `n <= fail_attempts`: if `n >= 3`, set `status='failed'`, `error='transient failure'`, `result_output=NULL`. Otherwise set `status='queued'`, `run_after=Date.now()+500`, `progress_completed=0`. Update `updated_at` in both cases.
    - Otherwise, for i = 1..steps: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. If `stopping`, break. After the loop: `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`, `error=NULL`.
    - Every status-changing UPDATE includes `WHERE id=? AND status='running'`.
11. **Worker shutdown**: SIGTERM/SIGINT sets `stopping`. If a job is mid-run, re-queue it the same way recovery does (status queued, attempts-1, progress 0). Then clear the interval, `db.close()` and exit 0. Use short sleeps so the worker exits in well under a second.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - `<div data-testid="form-error" role="alert"></div>`
    - `<ul data-testid="job-list">`
    - On submit (`preventDefault`): input is sent as a raw string. For the numeric fields, an empty value is omitted, a value whose `Number(v)` is finite is sent as that number, and anything else is sent as the raw string so the API rejects it. POST with the JSON Content-Type.
    - If the response is not OK, show `error.message` plus one line per `fields[]` entry (`field: message`) with textContent. If OK, clear the error, reset the input and refresh the list right away.
    - Refresh: `setInterval(refresh, 1000)` fetches `/api/jobs` and renders an `<li data-testid="job-item" data-job-id>` per job with `<span data-testid="job-status">`, `<span data-testid="job-progress">` showing `c/t`, and `<span data-testid="job-result">`. The result span holds the output if completed, the error if failed, otherwise ''. Use textContent only. Re-rendering the list only must leave form state untouched.

## Behaviours to verify
Run `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server` and `start:worker` in two terminals. Also run `npm run check:smoke` and `npm run check:contract` (see `checks/cli.ts` for how they locate the server).
- **Create and get**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}'` returns 201, queued, attempts 0, progress 0/2. GET by id works, and the list is newest first.
- **Validation**: `{"input":"x","steps":"2"}` gives 400 with field steps. `failAttempts:7` gives failAttempts. Unknown `colour` gives colour. A missing input gives input. Also check malformed JSON, `[]`, a text/plain Content-Type, a bad key `a b`, a whitespace-only input and `steps:1.5`. Afterwards the job count is unchanged.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 200 with the same id. Changing the input returns 409. A replay after restarting the server still returns 200.
- **Processing**: poll GET and see progress rise 0→N about every 100 ms. The job ends `completed` with output uppercased and attempts 1.
- **Retries**: `failAttempts:1, steps:1` completes with attempts 2. `failAttempts:2` gives attempts 3. `failAttempts:3` ends `failed` with error "transient failure", result null and attempts 3. Only one job is listed in each case.
- **Health**: `worker:"up"` with the worker running, and `"down"` within about 3 s of killing it.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run and restart it. The job completes and nothing is lost. Repeat with both processes killed.
- **SIGTERM**: both processes exit promptly with code 0.
- **Routing**: `DELETE /api/jobs` gives 405, `/nope` gives 404 `not_found`, and every response is JSON.
- **UI**: open `/`, submit, and watch status and progress update with no reload. Submit an empty input or steps 99 and `form-error` names the field.

## Risks
- **Browser validation**: without `novalidate` (or with `required`, `min` or `max` attributes), the browser blocks invalid submissions and `form-error` never shows the API's rejection. Keep `novalidate`.
- **Numeric strings**: don't coerce `"3"` on the server. Check `typeof` strictly.
- **Idempotency comparison**: compare the canonical payload *after defaults*, built with a fixed key order. Don't compare the raw body.
- **Lock contention**: a SQLITE_BUSY error can crash a process. Keep busy_timeout, keep transactions short, and always ROLLBACK in `finally` on error.
- **Attempts above 3 after a crash**: avoid this with the decrement in recovery and graceful shutdown. Never reprocess `completed` or `failed` jobs, so recovery only touches `running`.
- **Ordering**: sort by `seq`, never by the `createdAt` string, for both newest-first lists and oldest-first claims.
- **Content-Type**: it may arrive as `application/json; charset=utf-8`, so parse the media type rather than doing an equality check.
- **UI path**: `dist/server.js` loads `../ui/index.html` via `import.meta.url`. Keep that path working, and keep relative imports with the `.ts` extension, because `rewriteRelativeImportExtensions` is enabled.
- **Shutdown hangs**: open intervals or keep-alive sockets can stop a process from exiting. Clear timers, close connections and add a fallback `process.exit`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
