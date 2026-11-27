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
Keep the current layout: `src/db.ts` holds the shared schema and data access, `src/server.ts` is the `node:http` API plus static UI, `src/worker.ts` is the polling worker, and `ui/index.html` is a single page with inline JS. All state lives in SQLite via `node:sqlite` `DatabaseSync`, which is already in WAL mode with a busy timeout. There is one `jobs` table and one `heartbeat` table. The worker claims jobs atomically, writes progress after every step, sets retry times with a `run_after` column, and on startup puts any `running` jobs back in the queue. Idempotency uses a UNIQUE `idempotency_key` column plus the stored canonical payload, checked inside a `BEGIN IMMEDIATE` transaction so it holds across restarts and concurrent requests.

## Files
- `src/db.ts`: keep `openDatabase`. Add the schema (`CREATE TABLE IF NOT EXISTS`), a `JobRow` type, `rowToJob()` serializer and shared helpers (`nowIso()`, a `transaction(db, fn)` wrapper using `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`).
- `src/server.ts`: routing, body reading, validation, idempotency, health, serving the UI, SIGTERM shutdown.
- `src/worker.ts`: heartbeat, recovery, claim loop, step processing, retries, SIGTERM shutdown.
- `ui/index.html`: form, error region, polling job list with all required `data-testid`s.

## Steps
1. **Schema** (in `openDatabase`, run after the pragmas; both processes run it, and that is safe with IF NOT EXISTS and the busy timeout):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), ts INTEGER NOT NULL);
   ```
   `rowToJob` returns exactly these fields: `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Sort newest first by `seq DESC`, not by timestamp, because jobs created in the same millisecond have equal timestamps.
2. **Server helpers**: `send(res, status, body)` always sets `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)` builds the error shape. Read the body as a Buffer, capped at about 1 MB (return 400 for `body` if larger).
3. **Routing** (`new URL(req.url, 'http://x').pathname`):
   - `/`: GET serves the HTML, other methods get 405.
   - `/health`: GET only.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/<id>`: GET only, matched with `^/api/jobs/([^/]+)$`, then `decodeURIComponent` inside a try block (decode failure returns 404).
   - Any other method on these paths returns 405 `method_not_allowed`. Every other path returns 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` on unexpected errors.
4. **POST validation**: build a `fields` array and collect every problem before responding.
   - Content-Type: take the media type before `;`, trim and lowercase it. It must be `application/json`. If it is missing or different, add `{field:'body'}`.
   - `Idempotency-Key`: if the header is present, including an empty string, it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add `{field:'Idempotency-Key'}`.
   - Body: if the Content-Type is OK, run `JSON.parse`. A parse error or empty body adds `body` "malformed JSON". A value that is not a plain object (null, array, primitive) adds `body`.
   - Fields of an object body:
     - Every key other than `input`, `steps`, `failAttempts` adds that key's name.
     - `input` must be a string with `length` from 1 to 1000 and `trim() !== ''`. Store it unmodified.
     - `steps` and `failAttempts`: if `undefined`, use the default. Otherwise require `typeof === 'number' && Number.isInteger(v)` within range. `null` and `"3"` are rejected.
   - If `fields` is non-empty, return 400 `invalid_request`.
5. **Create plus idempotency**:
   - The canonical payload is `JSON.stringify({input, steps, failAttempts})` after defaults are applied, always in that key order.
   - Inside `transaction()`: if a key was given, run `SELECT * FROM jobs WHERE idempotency_key=?`. If a row is found, return 200 with that job when its `payload` matches, and 409 `idempotency_conflict` when it does not.
   - Otherwise insert with `id = randomUUID()`, status `queued`, both timestamps set to the same `new Date().toISOString()`, and `run_after = 0`. Return 201.
   - Also catch a UNIQUE constraint error: re-select the row and apply the same comparison.
6. **Health**: run `SELECT ts FROM heartbeat WHERE id=1`. Return `worker: 'up'` if the row exists and `Date.now() - ts < 3000`.
7. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add an unref'd 2 s fallback `process.exit(0)`. Keep the UI path as `new URL('../ui/index.html', import.meta.url)`, which works from `dist/`.
8. **Worker startup**:
   - Open the DB and write the heartbeat right away: `INSERT ... ON CONFLICT(id) DO UPDATE SET ts=excluded.ts`. Then run `setInterval(heartbeat, 500)`.
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. This re-runs the interrupted attempt with the same attempt number, so `attempts` never exceeds 3 and failure semantics stay consistent.
9. **Worker loop**: `while (!stopping)`:
   - **Claim** inside `transaction()`: select the first job with `status='queued' AND run_after<=now`, ordered by `seq ASC`, with `LIMIT 1`. Then `UPDATE ... SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`.
   - If nothing was claimed, `await sleep(200)` and continue.
   - **Process**: let `n` be the new `attempts`.
     - If `n <= fail_attempts`, the attempt fails at its first step: `await sleep(100)`, then fail without progress (see the retry bullet).
     - Otherwise, for each step: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps.
     - After the last step: `status='completed', result_output=input.toUpperCase(), progress_completed=steps, error=NULL`.
   - **Retry**: if `n < 3`, set `status='queued', progress_completed=0, run_after=Date.now()+500`. Otherwise set `status='failed', error='transient failure', result_output=NULL`.
   - **Stop mid-job**: put the job back as in recovery (queued, `attempts-1`).
10. **Worker shutdown**: SIGTERM sets `stopping`. After the loop exits, clear the interval, set the heartbeat `ts=0` and close the DB. Add a 3 s unref'd fallback exit.
11. **UI (`ui/index.html`)**:
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - `<div data-testid="form-error" role="alert"></div>`, empty by default.
    - `<ul data-testid="job-list">`.
    - **On submit** (`preventDefault`): build the body. The input string is sent as is. For each numeric field: omit it if empty; else send `Number(v)` if it is finite; else send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, fill `form-error` with `error.message` plus one line per field as `` `${f.field}: ${f.message}` ``.
    - On success, clear `form-error` and refresh right away.
    - Poll `GET /api/jobs` every 1000 ms. Render one `<li data-testid="job-item" data-job-id=id>` per job, in API order, with child spans `job-status`, `job-progress` (`completed/total`) and `job-result` (output if completed, error if failed, else `''`).
    - Use `textContent` only, never innerHTML with job data.

## Behaviours to verify
- **Build and start**: `npm run build && PORT=3100 DATABASE_PATH=/tmp/jt/a.db npm run start:server` plus `start:worker` in another terminal, in either order. The `/tmp/jt` directory gets created.
- **Health**: `curl :3100/health` shows `up` with the worker running, and `down` within 3 s after stopping it.
- **Create**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}'` returns 201 queued with `attempts` 0 and progress `0/3`.
- **Progress and completion**: polling GET shows progress increasing, then `completed` with `"HI"`.
- **Validation**: these each return 400 with the named field:
  - `steps:"2"` → `steps`
  - `failAttempts:7` → `failAttempts`
  - `colour:"blue"` → `colour`
  - missing input → `input`
  - `"   "` input → `input`
  - `[]` body → `body`
  - bad JSON → `body`
  - `text/plain` → `body`
  - key `"a b"` → `Idempotency-Key`

  The job count does not change.
- **Idempotency**: the same key and payload (with and without explicit defaults) returns 200 with the same id. A different payload returns 409. Restart the server and replay: still 200 with the same id.
- **Retries**: `failAttempts:1` gives completed with attempts 2. `failAttempts:2` gives completed with attempts 3. `failAttempts:3` gives failed, `"transient failure"`, attempts 3. Exactly one job in the list.
- **Routing**: `/nope` returns 404, `DELETE /api/jobs` returns 405, `GET /api/jobs/xyz` returns 404 `not_found`.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it, and the job completes. `kill -9` both processes, restart, and all jobs are still listed. Completed jobs keep their attempts unchanged.
- **SIGTERM**: `kill -TERM` exits each process promptly with code 0.
- **UI**: open `/`, submit, and watch status and progress update. Submit `steps` 50 and `form-error` shows "steps".
- **Bundled checks**: run `npm run check:smoke` and `npm run check:contract`. Read `checks/cli.ts` for the env vars and arguments they expect.

## Risks
- **Content type**: responses must use `application/json` on every path, including 404, 405 and 500. Use the single `send` helper everywhere.
- **Validation leaks**: do not let `steps: null` or `steps: 3.5` fall through to defaults. Only `undefined` gets the default.
- **Idempotency races**: do the check-then-insert in one `BEGIN IMMEDIATE` transaction. Always ROLLBACK on throw, or the connection stays locked.
- **Heartbeat stalls**: never block the worker event loop. Use `await sleep` between steps so the heartbeat interval keeps firing. Keep the heartbeat at 500 ms, well under 3 s.
- **SIGTERM hangs**: the worker loop must react within one step or poll interval. The server's keep-alive connections can block `close()`, so call `closeAllConnections()`.
- **Imports**: keep the `./db.ts` imports. `rewriteRelativeImportExtensions` turns them into `.js`. Don't use TS features that fail with `verbatimModuleSyntax` (use `import type` for types).
- **Ordering**: sort by `seq`, not `created_at`, for both newest-first lists and oldest-first claiming.
- **Browser validation**: the form needs `novalidate`, or the browser blocks out-of-range numbers before the API sees them. The evaluator expects API errors in `form-error`.
- **`progress.completed`**: it must be reset to 0 when the job goes back to `queued` and at each new attempt, and set to `steps` on completion.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
