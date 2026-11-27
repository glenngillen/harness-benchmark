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
I keep the existing layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (`node:http` API and the UI) and `src/worker.ts` (polling loop), plus a single static `ui/index.html` with inline JS. Both processes open the same SQLite file through `openDatabase()`. It keeps the busy_timeout/WAL pragmas and adds an idempotent `CREATE TABLE IF NOT EXISTS` migration. The `jobs` table holds all job state, including a `run_after` timestamp for retry delays and a `UNIQUE` idempotency key. The worker claims jobs inside `BEGIN IMMEDIATE` transactions, writes progress after each step and updates a heartbeat row, which `/health` reads. Everything uses only Node 22 built-ins (`node:sqlite` `DatabaseSync`, `node:http`, `node:crypto` `randomUUID`).

## Files
- `src/db.ts`: keep `openDatabase`. Add `migrate(db)` (called inside `openDatabase`), the `JobRow` type, `rowToJob(row)` (builds the API JSON shape), `nowIso()`, and helpers to read and write the heartbeat.
- `src/server.ts`: rewrite. Adds routing, body reading, validation, idempotent create, list/get, health, UI serving and SIGTERM shutdown.
- `src/worker.ts`: rewrite. Adds startup recovery, heartbeat interval, the claim/process loop, retries and SIGTERM shutdown.
- `src/validate.ts` (new, optional): a pure `validateSubmission(contentType, rawBody, idemKey)` that returns `{ok, payload}` or `{fields}`.
- `ui/index.html`: form, error region, job list and polling script.

## Steps
1. **Schema** in `migrate` (run `CREATE TABLE IF NOT EXISTS` for each):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE)`
   - an index on `(status, run_after, seq)`
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL)`

   `rowToJob` returns `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Use `?` positional params. Don't bind booleans or `undefined`; use `null`.
2. **Server routing**: parse the pathname with `new URL`.
   - `/health`: GET only.
   - `/`: GET only, serves the HTML. Keep the `../ui/index.html` URL relative to `import.meta.url`, which resolves correctly from `dist/`.
   - `/api/jobs`: GET or POST.
   - `/api/jobs/:id` (regex `^/api/jobs/([^/]+)$`, then decodeURIComponent): GET.
   - A known path with another method returns `405 method_not_allowed`. Anything else returns `404 not_found`.
   - All JSON goes through `send()`, which sets `application/json; charset=utf-8`.
   - Wrap the handler in try/catch so errors return `500 {error:{code:'internal_error',...}}`.
3. **Body reading**: collect chunks up to about 1 MB, then decode as UTF-8.
4. **Validation**: collect a `fields` array.
   - Content-Type missing or not matching `/^application\/json\b/i`: add `body` ("Content-Type must be application/json").
   - Otherwise `JSON.parse` in try/catch. On failure, add `body` (malformed JSON). If the result is not a plain object (null, an array or a primitive), add `body`.
   - If the body is an object, add every unknown key as its own field.
   - `input` must be a string with `length` from 1 to 1000 and `input.trim() !== ''`. Store it unmodified.
   - `steps`: if absent, default 5. Otherwise it must be `typeof === 'number' && Number.isInteger && 1..20`. Reject `null` and `"3"`.
   - `failAttempts`: same rule with range 0..5 and default 0.
   - `Idempotency-Key` header: if present (even empty), it must match `/^[A-Za-z0-9_-]{1,128}$/`, otherwise add field `"Idempotency-Key"`. Check it even when the body is invalid.
   - If `fields` is not empty, return `400 {error:{code:'invalid_request', message:'Invalid request', fields}}`.
5. **Create** in one transaction (`BEGIN IMMEDIATE` … `COMMIT`, with ROLLBACK in a catch):
   - If there is a key, `SELECT` by `idempotency_key`. If found, compare `input`, `steps` and `fail_attempts` with the payload after defaults. Equal returns `200` with the job. Different returns `409 idempotency_conflict`.
   - Otherwise `INSERT` with `id=randomUUID()`, `status='queued'`, `attempts=0`, `progress=0`, `created_at=updated_at=nowIso()`, `run_after=0`, and the key or NULL. Return `201`.
   - Backstop: on a UNIQUE constraint error, re-select and apply the same comparison.
6. **List and get**: `SELECT * FROM jobs ORDER BY seq DESC` returns `{jobs}`. Get by `id` returns the job or `404 not_found`.
7. **Health**: `worker = Date.now() - heartbeat.last_seen < 3000 ? 'up' : 'down'`. Use `'down'` if there is no row.
8. **Server SIGTERM/SIGINT**: call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a 2 s `setTimeout(...).unref()` force-exit as a fallback.
9. **Worker startup**:
   - Open the DB and write the heartbeat right away (`INSERT ... ON CONFLICT(id) DO UPDATE SET last_seen=?`).
   - Run `setInterval(heartbeat, 500)`.
   - Recovery: `UPDATE jobs SET status='queued', progress_completed=0, run_after=0, updated_at=? WHERE status='running'` (there is only one worker process).
   - Log "worker started".
10. **Worker loop**: `while (!stopping)`:
    - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`. If a row is found, `UPDATE SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`, then COMMIT.
    - If nothing was claimed, `await sleep(200)`.
    - Otherwise, with `n` = the new attempts count:
      - If `n <= fail_attempts`: sleep about 100 ms, then fail the attempt. If `n >= 3`, set `status='failed', error='transient failure', result_output=NULL`. Otherwise set `status='queued', run_after=Date.now()+500, progress_completed=0`. Always update `updated_at`.
      - Otherwise, for each step i=1..steps: if `stopping`, break out. Otherwise `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`.
      - After the last step, `UPDATE status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Guard every update with `WHERE id=? AND status='running'`.
11. **Worker SIGTERM/SIGINT**: set `stopping=true`. If a job is mid-run, the loop requeues it (`status='queued', progress_completed=0, run_after=0`). Leave `attempts` as is, since that attempt was started. Then `clearInterval`, set `heartbeat last_seen=0` so health shows down at once, `db.close()` and exit 0. The response to the signal must finish well within a few seconds: steps are 100 ms and the idle sleep is 200 ms.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing `<input data-testid="job-input">`, `<input data-testid="job-steps" type="number" value="5">`, `<input data-testid="job-fail-attempts" type="number" value="0">` and `<button data-testid="job-submit" type="submit">`.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - Do not use HTML `min`/`max`/`required`, which could stop out-of-range values from reaching the API.
    - **Submit**: call `preventDefault`. Build the body as `{input: value}`. For each numeric field: if the trimmed value is `''`, omit it. Else if `Number.isFinite(Number(v))`, send `Number(v)`. Else send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, set `form-error` to the message plus a line per field: `${field}: ${message}`.
    - On success, clear `form-error`, clear the input and refresh at once.
    - **Polling**: `setInterval(refresh, 1000)` calls `GET /api/jobs`. Render each job as `<li data-testid="job-item" data-job-id=id>` with `<span data-testid="job-status">`, `<span data-testid="job-progress">${completed}/${total}</span>` and `<span data-testid="job-result">` (the output if completed, the error if failed, else empty).
    - Use `textContent` only and keep the API order (newest first). Reuse `li` elements keyed by id if convenient; never re-render the form.
13. Run `npm run build`. It must compile under strict TS with `verbatimModuleSyntax` (use `import type`) and keep `.ts` import extensions, as the scaffold does.

## Behaviours to verify
- **Build and start**: run `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/jt/x/jobs.db npm run start:server` and `npm run start:worker` in either order. The nested directory should be created.
- **Fixed checks**: `npm run check:smoke` and `npm run check:contract` (read `checks/cli.ts` for the env/args they expect).
- **Health**: `curl /health` returns `up` while the worker runs, and `down` within about 3 s of killing it (at once after SIGTERM).
- **Create and complete**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"héllo","steps":3}'` returns 201 queued. Poll GET `/api/jobs/:id` to see progress 1/3, 2/3, then completed with output `HÉLLO`.
- **Validation**: each of these returns 400 with the right `fields`:
  - `{"input":"a","steps":"3"}` gives `steps`
  - `{"input":"   "}` gives `input`
  - `{"input":"a","x":1}` gives `x`
  - `[1]`, `not json`, or no Content-Type gives `body`
  - `steps:1.5`, `steps:21`, `failAttempts:6`
  - `Idempotency-Key: bad key!`
  - an input of 1001 characters

  `GET /api/jobs` should show no new jobs.
- **Idempotency**: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` returns 201 then 200 with the same id. The same key with `{"input":"b"}` returns 409. Restart the server and replay: still 200, same id.
- **Retries**: `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with `error "transient failure"`, `result null` and attempts 3. Watch `queued` show up between attempts.
- **Routing**: `/nope` returns 404 `not_found`. `DELETE /api/jobs` returns 405. `/api/jobs/unknown` returns 404.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, then restart. The job should complete within a few seconds. Completed jobs must not change (`updatedAt` stays the same).
- **SIGKILL both processes**: restart both; all jobs are still listed.
- **UI**: open `/`, submit a job, and watch status and progress update without a reload. Submit `steps=50` and `form-error` should mention `steps`.

## Risks
- **Content-Type check**: the comparison must allow `application/json; charset=utf-8`. Use a regex, not equality.
- **Type checks**: `typeof x === 'number'` is required so `"3"` is rejected. `Number.isInteger` rejects NaN and 1.5. JSON can't produce NaN, but `null` must be rejected rather than defaulted.
- **Field names**: unknown fields must each be listed by name. Use `"body"` only for whole-body problems.
- **Browser validation**: HTML number constraints or `required` would stop submissions before they reach the API, and `form-error` would never show. Use `novalidate` and no min/max.
- **Heartbeat timing**: use epoch ms, not ISO strings, to avoid timezone and parse issues. Write it on an interval independent of job processing; the sync DB calls are short, so the timer still fires.
- **SQLITE_BUSY**: run migrations in both processes; busy_timeout covers it. Always ROLLBACK on error inside transactions so the connection isn't left mid-transaction.
- **Ordering**: sort by `seq`, not `createdAt`, since timestamps can tie at ms resolution.
- **Lost jobs on shutdown**: the worker must not exit leaving a job `running` forever. Startup recovery covers SIGKILL, and the SIGTERM path requeues.
- **Hanging shutdown**: open keep-alive connections can keep the server running after SIGTERM. Use `closeAllConnections()` plus the force-exit timer.
- **XSS in the UI**: build the DOM with `textContent`, never `inn
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
