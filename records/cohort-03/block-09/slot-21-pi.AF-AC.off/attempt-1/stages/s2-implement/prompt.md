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
There are three modules plus a UI page. `src/db.ts` holds the schema, row-to-JSON mapping and shared queries. `src/server.ts` is a `node:http` server that does routing, validation and idempotency. `src/worker.ts` is a single-worker loop that claims jobs, processes them step by step and writes progress to SQLite. The two processes talk only through the DB: a `jobs` table and a `worker_heartbeat` table. Both run idempotent `CREATE TABLE IF NOT EXISTS` at startup, so either can start first. Retries use a `run_at` column, so a waiting job stays `queued` and is not eligible until its delay has passed. Crash recovery runs when the worker starts: any job still `running` goes back to `queued`.

## Files
- `src/db.ts`: keep `openDatabase` (it already does mkdir, busy_timeout and WAL). Add `initSchema(db)`, `rowToJob(row)` and `nowIso()`.
- `src/server.ts`: rewrite with routing, validation, idempotency, health, the jobs endpoints, serving `ui/index.html`, and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, recovery, the claim/process loop, retries, and SIGTERM handling.
- `ui/index.html`: form plus job list with inline JS that polls every 1 s, using all the required `data-testid`s.

## Steps
1. **Schema** (`initSchema`, run in `openDatabase` or straight after it in both processes):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     run_at INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_at, seq);
   CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL);
   ```
   - `payload` holds the canonical JSON `{"input","steps","failAttempts"}`, built in that fixed key order after defaults are applied.
   - `rowToJob` maps a row to the exact JSON shape: `result` is `{output}` only when `status='completed'`, `error` is set only when failed, and `progress` is `{completed: progress, total: steps}`.
2. **Server helper**: `send(res, status, body)` always sets `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)` builds the error shape.
3. **Routing**: parse `pathname`.
   - `/health`: GET only.
   - `/`: GET serves the HTML.
   - `/api/jobs`: GET or POST.
   - `/api/jobs/:id`: GET only. Match with `^/api/jobs/([^/]+)$` and decodeURIComponent it inside a try.
   - Any other method on these paths returns 405 `method_not_allowed`. Any other path returns 404 `not_found`.
   - Wrap the handler in try/catch so an unexpected error returns 500 `internal_error` as JSON.
4. **Health**: `SELECT beat_at FROM worker_heartbeat WHERE id=1`. `worker` is `"up"` if `Date.now() - beat_at < 3000`.
5. **POST validation**, collecting every error into `fields` before responding:
   - **Idempotency-Key**: if the header is present and fails `^[A-Za-z0-9_-]{1,128}$`, add field `"Idempotency-Key"`.
   - **Content-Type**: it must exist and `split(';')[0].trim().toLowerCase() === 'application/json'`. Otherwise add field `"body"` and skip body parsing.
   - **Body**: read the whole body. `JSON.parse` failure adds `"body"`. Anything that isn't a plain object (null, array, primitive) adds `"body"`.
   - **Object fields**:
     - Each key not in {input, steps, failAttempts} adds an entry with that key as `field`.
     - `input`: missing, not a string, length 0 or >1000, or `trim()===''` → add `"input"`.
     - `steps`: if present, it must be `typeof number`, `Number.isInteger`, and 1..20.
     - `failAttempts`: same rule, 0..5.
   - If any errors were collected, return 400 `invalid_request` with `fields`.
6. **Create job**:
   - Apply defaults (steps 5, failAttempts 0) and build the canonical payload string.
   - If a key is present, look up `SELECT * FROM jobs WHERE idempotency_key=?`. If it exists: same payload → 200 with that job; different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT with `id=randomUUID()`, `status='queued'`, `run_at=Date.now()`, and createdAt = updatedAt = `new Date().toISOString()`. Return 201.
   - Catch a UNIQUE-constraint error on the insert, re-select, and apply the same comparison.
7. **List and get**: list is `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs}`. Get is by id, or 404 `not_found`.
8. **Server shutdown**: on SIGTERM/SIGINT call `server.close()`, then `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Add a 2 s `setTimeout(...).unref()` fallback exit. Log once listening.
9. **Worker startup**:
   - `openDatabase()` and `initSchema`.
   - Write a heartbeat immediately (`INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`), then every 500 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, run_at=<now>, updated_at=<now> WHERE status='running'`. The interrupted attempt is redone under the same number, so the 3-attempt cap and the `failAttempts` semantics still hold.
10. **Worker loop** (`while (!stopping)`):
    - Claim inside `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY seq ASC LIMIT 1`. If found, `UPDATE ... SET status='running', attempts=attempts+1, progress=0, updated_at=?`, then COMMIT.
    - If nothing was claimed, sleep 200 ms.
    - Let `n` be the new attempt count.
    - **If `n <= fail_attempts`** (fail at the first step, before any progress):
      - If `n >= 3`: set `status='failed'`, `error='transient failure'`, `output=NULL`.
      - Otherwise: set `status='queued'`, `run_at=now+500`, `progress=0`.
    - **Otherwise**: for each step i = 1..steps:
      - Sleep 100 ms.
      - If `stopping`, break. Leave the job `running` so recovery redoes it, or requeue it with `attempts-1` straight away. The latter is preferred because it is cleaner.
      - `UPDATE jobs SET progress=i, updated_at=? WHERE id=?`.
    - After the last step: `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
    - Always bump `updated_at`.
11. **Worker shutdown**: on SIGTERM/SIGINT set `stopping`. After the loop ends, clear the interval, optionally delete the heartbeat row, `db.close()`, and exit 0. All sleeps are ≤100–200 ms, so exit happens within about 300 ms.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form">` containing:
      - `<input data-testid="job-input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - **Submit**: `preventDefault`. Build the body from the field values. Numeric fields go through `Number(value)`; if a field is empty, still send `Number`. Do not add any client-side validation that blocks sending, and no `required`/`min`/`max` attributes, because the browser would stop the submission before the API ever sees it. Add `novalidate` on the form.
    - POST with `content-type: application/json`.
    - On a non-2xx response, fill `form-error` with `error.message` plus each `field: message`. On success, clear it, clear the input, and refresh.
    - **Polling**: `refresh()` runs `GET /api/jobs` every 1000 ms and re-renders. Each job renders as `<li data-testid="job-item" data-job-id=id>` containing spans `job-status` (status), `job-progress` (`${completed}/${total}`), `job-result` (`result?.output ?? error ?? ''`), and the input text.
    - Use `textContent` everywhere, never innerHTML with user data.
13. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and checks**: `npm run build && npm run check:smoke && npm run check:contract` all pass.
- **Health**: start only the server and `/health` says worker `down`. Start the worker and it says `up` within 1 s. Kill the worker and it says `down` after about 3 s.
- **Create, list, get**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}' :3000/api/jobs` returns 201 queued with attempts 0 and progress 0/2. The list shows it first. `GET /api/jobs/nope` returns 404 `not_found`.
- **Validation**:
  - These each return 400 with the named field: `{"input":"x","steps":"2"}` (steps), `failAttempts:7`, `{"colour":"blue"}` (colour plus input), `{"steps":2}` (input), `"   "` as input, `steps:1.5`, `[]` (body), malformed JSON (body).
  - No Content-Type and `text/plain` both return 400 (body).
  - A bad Idempotency-Key such as `a b` returns 400 (Idempotency-Key).
  - The job count is unchanged afterwards.
- **Routing**: `DELETE /api/jobs` returns 405. `/nope` returns 404.
- **Progress**: poll a `steps:10` job and watch progress climb, then completed with `HI` and progress 10/10, attempts 1.
- **Retries**: `failAttempts:1` completes with attempts 2. `failAttempts:2` completes with attempts 3. `failAttempts:3` ends failed with `error:"transient failure"`, result null, attempts 3. The list shows only one job per submission.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 201 then 200 with the same id. A different input returns 409. Restart the server, replay, and it still returns 200 with the same id.
- **Durability**: submit a `steps:20` job and `kill -9` the worker mid-run. Restart it and the job completes. `kill -9` both processes and restart: all jobs are still present, and completed jobs keep their attempts unchanged.
- **Shutdown**: `kill -TERM` each process and it exits within 1–2 s.
- **UI**: open `/`, submit, and watch status and progress update without a reload. Set steps to 50 and `form-error` shows `steps`.

## Risks
- **`node:sqlite` binding errors**: it rejects `undefined` bindings, so pass `null` explicitly. Use `.get()` and `.all()` with positional params.
- **Startup schema race**: both processes create the schema at the same time. busy_timeout covers it; keep the schema statements in one `db.exec`.
- **Imports**: source imports use the `.ts` extension (`./db.ts`), which `rewriteRelativeImportExtensions` turns into `.js`. Keep that style. The UI path stays `new URL('../ui/index.html', import.meta.url)`, which resolves from `dist/`.
- **JSON content type**: every response except `/` must be JSON, including 404, 405 and 500.
- **Type checks**: don't accept numeric strings or booleans for numbers. Check `typeof v === 'number'`, because `Number.isInteger("3")` is false anyway but coercion elsewhere could slip in.
- **Idempotency payload**: compare the canonical payload with defaults applied, not the raw body. Without a key, `idempotency_key` must be NULL, never an empty string, so the UNIQUE constraint doesn't collide.
- **Retry delay bounds**: keep it inside 250 ms–2 s (use 500 ms). Keep the idle poll ≤200 ms so new jobs start within 1 s.
- **Attempt cap**: never exceed 3 attempts. This is why recovery decrements attempts for interrupted runs. Never touch completed or failed rows in recovery.
- **Hanging SIGTERM**: the HTTP server can hang on keep-alive connections, so call `closeAllConnections()` and add the fallback exit timer.
- **UI blocking submissions**: HTML5 `min`/`max`/`required` would block invalid submissions in the browser. Use `novalidate` and no constraints, so the API rejection shows in `form-error`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
