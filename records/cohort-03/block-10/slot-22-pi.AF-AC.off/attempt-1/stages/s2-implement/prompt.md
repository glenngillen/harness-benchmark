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
Keep the existing layout. `src/server.ts` and `src/worker.ts` are the two entry points, and both share `src/db.ts`, which opens the database and creates the schema. All state lives in SQLite through `node:sqlite` `DatabaseSync`: a `jobs` table, an `idempotency_keys` table and a `heartbeat` table. The worker claims jobs with an atomic conditional UPDATE, writes progress after every step, and writes a heartbeat every 500 ms. Retries are stored as a `run_after` timestamp on the queued job, and recovery after a crash comes from a lease column. The UI is a single static `ui/index.html` with plain JS that polls `GET /api/jobs` every 500 ms and renders the required `data-testid` elements.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, then WAL). Add idempotent `CREATE TABLE IF NOT EXISTS` schema creation, called from `openDatabase`. Add `rowToJob(row)`, which maps a row to the API JSON shape.
- `src/validate.ts` (new): `validateSubmission(contentType, rawBody, idemKey)` returns either `{ok:true, payload:{input,steps,failAttempts}}` or `{ok:false, fields:[...]}`.
- `src/server.ts`: HTTP routing, JSON errors, job create/list/get, idempotency, health and the UI route. Handle SIGTERM.
- `src/worker.ts`: heartbeat, claim loop, step processing, retries, crash recovery and SIGTERM.
- `ui/index.html`: form, error region, job list and polling.

## Steps
1. **Schema** in `db.ts`, using `db.exec` with `IF NOT EXISTS`:
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER UNIQUE, status TEXT, input TEXT, steps INT, fail_attempts INT, attempts INT DEFAULT 0, progress INT DEFAULT 0, output TEXT NULL, error TEXT NULL, run_after INTEGER DEFAULT 0, lease_until INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`.
     - Simplest option: use `seq INTEGER PRIMARY KEY AUTOINCREMENT` and keep `id TEXT UNIQUE` with `crypto.randomUUID()`. Order by `seq` (newest first = `seq DESC`; oldest first = `seq ASC`).
   - `idempotency_keys(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`.
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER)`.
   - Index on `jobs(status, run_after, seq)`.
   - Timestamps are `new Date().toISOString()`. Times used for scheduling are `Date.now()` integers.
2. **`rowToJob`**: `{id, status, input, steps, failAttempts, attempts, progress:{completed, total:steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
3. **Validation**, in this order:
   - If the `Idempotency-Key` header is present and fails `^[A-Za-z0-9_-]{1,128}$`, add field `"Idempotency-Key"`. Collect this error but keep validating so other field errors are reported too.
   - If the content-type is missing or not `application/json` (parse the media type before `;`, case-insensitive), add `body`.
   - Otherwise `JSON.parse` the body; on failure add `body`. If the result is not a plain object (`null`, an array or a primitive), add `body`.
   - For an object: add each unknown key as its own field. `input` must be `typeof string`, have `length` 1–1000 and satisfy `trim() !== ''`. `steps`, if present (not undefined), must satisfy `typeof number && Number.isInteger && 1..20`. `failAttempts` must be 0..5 under the same rules.
   - Reject `null` for steps/failAttempts as a wrong type. Do not trim the stored input.
   - Return 400 `{error:{code:'invalid_request', message:'Invalid request', fields}}`.
4. **Server routing**:
   - Read the full body as a Buffer and decode it as UTF-8.
   - Routes: `/` (GET → HTML), `/health` (GET), `/api/jobs` (GET, POST) and `/api/jobs/:id` (GET; match `^/api/jobs/([^/]+)$`, decodeURIComponent).
   - Known path with a wrong method → 405 `method_not_allowed` (add an `Allow` header). Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` JSON on failure.
   - Every JSON response uses `content-type: application/json; charset=utf-8`.
5. **POST create**: after validation, `canonical = JSON.stringify({input, steps, failAttempts})` in a fixed key order. Inside `BEGIN IMMEDIATE` … `COMMIT` (ROLLBACK on error):
   - With a key: SELECT from `idempotency_keys`. If a row exists and its payload equals canonical → 200 with the job. If it exists with a different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT the job (status `queued`, attempts 0, progress 0, run_after 0), INSERT the key row if there is one, and return 201.
   - Using one transaction plus the PK on `key` guarantees one job per key, including when two submissions race.
6. **GET list/get**: list is `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. Get is by id, or 404 `not_found`.
7. **Health**: read `heartbeat.at`. Report `worker:'up'` if `Date.now()-at < 3000`, else `'down'`, including when there is no row.
8. **Worker loop**:
   - `setInterval` 500 ms runs `INSERT OR REPLACE INTO heartbeat(id,at) VALUES(1,?)`. Write one heartbeat immediately at startup.
   - Main loop while `!stopping`: try to claim; if nothing was claimed, `await sleep(100)`.
   - **Claim**: in `BEGIN IMMEDIATE`:
     - SELECT the first job by `seq ASC` that is either `status='queued' AND run_after<=now`, or `status='running' AND lease_until<now` (a crashed or stale running job).
     - UPDATE it to `status='running', attempts=attempts+1, progress=0, output=NULL, error=NULL, lease_until=now+3000, updated_at`.
     - COMMIT.
   - **Startup recovery**: because only one worker exists, the worker also resets any `running` job to `queued` with `run_after=0` at startup, so the job is picked up immediately rather than waiting for the lease to expire. Leave `attempts` as is, so the re-run counts as a new attempt.
   - **Process attempt n = attempts**:
     - If `n <= fail_attempts`, fail at once with no progress. If `n >= 3`, set `status='failed', error='transient failure', output=NULL, lease_until=0`. Otherwise set `status='queued', progress=0, run_after=now+500, lease_until=0`.
     - Otherwise, for each step i=1..steps: `await sleep(100)`, then `UPDATE progress=i, lease_until=now+3000, updated_at WHERE id=? AND status='running'`.
     - After the last step, set `status='completed', output=input.toUpperCase(), progress=steps`.
     - If `stopping` becomes true mid-job, stop between steps and set the job back to `queued` with `run_after=0` so it reprocesses after a restart. Alternatively leave it running and let startup recovery handle it; either is fine.
9. **Worker SIGTERM**: set `stopping`. The loop exits after the current step. Clear the interval, close the db and `process.exit(0)`.
   - **Server SIGTERM**: `server.close()`, then `db.close()` and `process.exit(0)`. Add a fallback `setTimeout(()=>process.exit(0),2000).unref()`.
   - Also call `server.closeAllConnections?.()` so keep-alive connections don't block shutdown.
10. **UI** (`ui/index.html`):
    - `<form data-testid="job-form">` containing `<input data-testid="job-input" name="input">`, `<input type="number" data-testid="job-steps" value="5">`, `<input type="number" data-testid="job-fail-attempts" value="0">` and `<button type="submit" data-testid="job-submit">`. Use `novalidate` on the form, with no `required`/`min`/`max` attributes, so the API performs validation.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - **On submit**: `preventDefault`. Read the numeric fields: if a field is empty, omit it (so the API default applies); otherwise send `Number(value)`. If the result is NaN, send the raw string so the API rejects it. POST with `Content-Type: application/json`.
    - **Response handling**: on non-2xx, render `error.message` plus each `field: message` from `fields` into form-error using `textContent`. On success, clear form-error and refresh the list immediately.
    - **Rendering**: poll `/api/jobs` every 500 ms and rebuild the list. Each item is `<li data-testid="job-item" data-job-id=id>`, containing spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, else ''). Set all of these with textContent, never innerHTML.
11. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and start**: `npm run build`, start both processes with `PORT=3100 DATABASE_PATH=/tmp/t/x.db`, then `curl localhost:3100/health` → `worker:"up"`. Kill the worker; within 3 s health reports `"down"`.
- **Create and complete**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"héllo","steps":3}'` → 201 queued. Poll GET by id and watch `progress.completed` go 0→3, then `completed` with output `HÉLLO`.
- **Validation**: each of these returns 400 `invalid_request` with the right `fields` entry: `{"input":"a","steps":"3"}`, `{"input":"   "}`, `{"input":"a","x":1}`, `[]`, `not json`, missing content-type, `steps:1.5`, `steps:21`, `failAttempts:6`, and header `Idempotency-Key: bad key!`. After all of them, `GET /api/jobs` count is unchanged.
- **Retries**: `failAttempts:2` → completes with attempts 3. `failAttempts:3` → failed, attempts 3, error `"transient failure"`, result null. While the job waits between attempts, its status is `queued`.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` → 201, then 200 with the same id. The same key with `{"input":"b"}` → 409. Restart the server and replay → 200 with the same id.
- **Routing**: `DELETE /api/jobs` → 405, `/nope` → 404, `/api/jobs/zzz` → 404. All are JSON with `application/json`.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run and restart it. The job reruns, completes, and its attempts value goes up by one. Kill both processes with SIGKILL, restart them, and check that every job is still listed. Confirm completed jobs are untouched (`updatedAt` unchanged).
- **SIGTERM**: `kill -TERM` each process; it exits promptly with code 0.
- **UI**: open `/`, submit a job and watch the status and progress update without a reload. Submit `steps` = 50 and confirm form-error shows "steps".

## Risks
- **Import extensions**: imports must keep the `.ts` extension (`./db.ts`), because tsconfig uses `rewriteRelativeImportExtensions`. Use `import type` for type-only imports (`verbatimModuleSyntax`).
- **`node:sqlite` values**: it returns `null` for SQL NULL, and integers may come back as numbers. Pass `undefined` → `null` explicitly when binding, because binding `undefined` throws.
- **Concurrent access**: both processes write to the database, so always use `BEGIN IMMEDIATE` for read-then-write sequences. Keep busy_timeout. Never hold a transaction open across an `await`.
- **Progress write order**: the UPDATE after each step must happen right after that step's sleep. Don't batch the updates.
- **Startup reset**: only the worker resets `running` jobs at startup; the server must never do this. Do not reprocess `completed`/`failed` jobs; the claim query must only select `queued` or lease-expired `running` jobs.
- **Retry delay bounds**: keep it within 250 ms–2 s (use 500 ms). The idle poll interval of 100 ms ensures a new job starts within 1 s.
- **`typeof` checks**: `typeof NaN === 'number'`. `Number.isInteger` handles this, but make sure `true`/`null` are also rejected for numeric fields.
- **Empty `fields`**: the 400 response must always include a non-empty `fields` array.
- **Idempotency validation order**: validation runs before the idempotency lookup, so an invalid body with a known key returns 400, not 200/409.
- **UI escaping**: use textContent everywhere to avoid XSS from job input. The form-error region must be empty when there is no error, so clear it on success.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
