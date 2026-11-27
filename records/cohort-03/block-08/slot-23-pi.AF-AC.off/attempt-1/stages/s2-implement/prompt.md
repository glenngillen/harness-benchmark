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
I'll keep the current layout: `src/db.ts` holds the schema and shared data access, `src/server.ts` serves the API and the UI, `src/worker.ts` runs the job loop, and `ui/index.html` is a single static page with inline JS. The server and worker only share the SQLite database (WAL mode, busy_timeout). The worker writes a heartbeat row every 500 ms, and `/health` reads it. Job claims, retries and recovery are all done with SQL `UPDATE` statements, so the work survives `SIGKILL`. Idempotency keys go in a table with a UNIQUE key column and are written in the same transaction as the job insert.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` for `jobs`, `idempotency_keys` and `heartbeat`. Add a `rowToJob(row)` serializer and the shared types.
- `src/server.ts`: add routing, validation, the job endpoints, idempotency, `/health` from the heartbeat, a JSON 404/405, and graceful shutdown on SIGTERM/SIGINT.
- `src/worker.ts`: add the heartbeat, startup recovery, a claim loop, step processing, retries, and graceful shutdown.
- `ui/index.html`: add the form, error region and job list with the required `data-testid`s, plus polling every 1 s.

## Steps
1. **Schema** in `db.ts`. Run it from `openDatabase` after the pragmas, in a single `db.exec`, using `IF NOT EXISTS`.
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER UNIQUE, status TEXT, input TEXT, steps INT, fail_attempts INT, attempts INT DEFAULT 0, progress INT DEFAULT 0, output TEXT NULL, error TEXT NULL, run_after INTEGER DEFAULT 0 /* epoch ms */, created_at TEXT, updated_at TEXT)`. Use `rowid`/an autoincrement `seq` for ordering, because timestamps can tie.
   - `idempotency_keys(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`.
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)`.
   - Both processes may run the schema at the same time. `IF NOT EXISTS` plus busy_timeout covers that.
   - `rowToJob` returns exactly these keys: id, status, input, steps, failAttempts, attempts, `progress:{completed,total:steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`, createdAt, updatedAt.
2. **Server routing.** Parse the pathname.
   - Known paths: `/` (GET), `/health` (GET), `/api/jobs` (GET, POST), and `/api/jobs/:id` matched by `^/api/jobs/([^/]+)$` (GET).
   - A known path with the wrong method returns 405 `method_not_allowed`. Anything else returns 404 `not_found`.
   - Every response is JSON with `content-type: application/json; charset=utf-8`, except `/`, which is HTML.
   - Wrap the handler in try/catch so an exception returns 500 `internal_error`.
3. **POST validation.** Read the full body as a string.
   - Content-Type, parsed with `split(';')[0].trim().toLowerCase()`, must be `application/json`. Otherwise reject with field `body`.
   - Check the `Idempotency-Key` header (`req.headers['idempotency-key']`) against the regex. If it fails, add field `Idempotency-Key`.
   - Run `JSON.parse` in a try. On failure, field `body`.
   - The result must be a non-null, non-array object. Otherwise field `body`.
   - Each key other than input/steps/failAttempts is reported under its own name.
   - `input`: `typeof === 'string'`, length 1–1000, and `trim() !== ''`.
   - `steps`/`failAttempts`: when present (not `undefined`), they must satisfy `typeof === 'number' && Number.isInteger(v)` and be in range. An explicit `null` is rejected.
   - Collect every error and return 400 `{error:{code:'invalid_request',message,fields}}`. Header errors and body errors can appear together.
4. **Create** inside `BEGIN IMMEDIATE … COMMIT`, with ROLLBACK on error.
   - Build the normalized payload as `JSON.stringify({input, steps, failAttempts})` in a fixed key order.
   - If there is a key, look it up. Same payload: return 200 with the existing job. Different payload: 409 `idempotency_conflict`.
   - Otherwise insert the job: id from `randomUUID()`, status `queued`, both timestamps `new Date().toISOString()`, `run_after=0`. Insert the key row if there is one, then commit and return 201.
   - `BEGIN IMMEDIATE` serializes concurrent requests that share a key, and the PRIMARY KEY is the backstop.
5. **GET list:** `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs:[...]}`. **GET one:** return the job, or 404 `not_found`.
6. **Health:** `worker = (Date.now() - heartbeat.at) < 3000 ? 'up' : 'down'`. A missing row means `down`.
7. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()`, then `db.close()`, then `process.exit(0)`. Add a 2 s fallback exit. Use `server.closeAllConnections?.()` so keep-alive connections don't block the close.
8. **Worker startup.**
   - Open the DB.
   - Upsert the heartbeat now, then every 500 ms with `setInterval`. Use `INSERT ... ON CONFLICT(id) DO UPDATE`.
   - Recovery: `UPDATE jobs SET status='queued', run_after=0, updated_at=? WHERE status='running'`. Only one worker exists, so any `running` row is orphaned.
   - Recovery does not undo the attempt. The next claim increments `attempts`, so a crashed attempt counts toward the 3.
   - If a recovered job already has `attempts>=3`, mark it `failed` with "transient failure" only if it would fail again (`attempts+1 <= failAttempts` and `attempts>=3`). Simpler alternative: at claim time, if `attempts>=3`, fail it immediately.
   - Recommended: re-run recovered jobs with no attempt cap check beyond the normal rule, i.e. a claim where `attempts` is already 3 marks the job `failed`. That handles the edge case.
9. **Worker loop**, while not stopping.
   - In a transaction, select `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`.
   - If there is none, sleep 200 ms.
   - Otherwise set `status='running', attempts=attempts+1, progress=0, updated_at`. Let `n` = the new attempts value.
   - If `n <= fail_attempts`, the attempt fails before any progress:
     - `n < 3`: set `status='queued'`, `run_after=now+500`, `updated_at`.
     - `n >= 3`: set `status='failed'`, `error='transient failure'`, `output=NULL`.
   - Otherwise, for each step i from 1 to steps: `await sleep(100)`, then `UPDATE progress=i, updated_at`.
   - When steps are done: `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
   - Guard every update with `WHERE id=? AND status='running'`.
10. **Worker shutdown.** SIGTERM sets `stopping`.
    - The loop checks `stopping` between steps. If it is set mid-job, put the job back to `queued` (progress 0, without touching attempts), or leave it `running` and let recovery handle it.
    - Then clear the interval, close the DB, and exit 0 within about 1 s. Add a fallback timer with `process.exit(0)` after 3 s.
11. **UI.**
    - The form (`job-form`) has `job-input` (input type text), `job-steps` (type number, value 5), `job-fail-attempts` (type number, value 0), and `job-submit`.
    - Add `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - On submit: preventDefault. Build the body as `{input, steps: Number(v), failAttempts: Number(v)}`, but if a numeric field is empty, send its raw string instead of `NaN`/`0` so the API rejects it. Also add `novalidate` on the form so the browser doesn't block bad values; the API must validate.
    - POST with `content-type: application/json`.
    - If the response is not ok, set form-error textContent to `message` plus each `field: message`. If it is ok, clear form-error and refresh.
    - Poll `GET /api/jobs` every 1000 ms. Render `li[data-testid=job-item][data-job-id]` with spans `job-status`, `job-progress` (`c/t`), and `job-result` (output, or error, or empty).
    - Use `textContent` (never innerHTML with user input) and keep newest-first order.

## Behaviours to verify
- **Build and start:** `npm run build && PORT=3100 DATABASE_PATH=/tmp/t/jobs.db npm run start:server` and `start:worker` (in either order). Check that `curl /health` shows `worker:"up"`. Kill the worker, wait about 3 s, and check it shows `down`.
- **Contract checks:** `npm run check:smoke` and `npm run check:contract` (read `checks/cli.ts` for the env/port it expects).
- **Validation:** curl these cases:
  - no content-type;
  - `text/plain`;
  - `{bad`;
  - `[]`;
  - `{"input":"  "}`;
  - `{"input":"a","steps":"3"}`;
  - `steps:1.5`, `steps:21`, `failAttempts:6`;
  - an extra field `x`;
  - the header `Idempotency-Key: bad key!`.

  Every case should return 400 with the matching `fields[].field`, and the job count should not change.
- **Idempotency:**
  - Send key K with `{"input":"a"}`: 201.
  - Repeat with `{"input":"a","steps":5,"failAttempts":0}`: 200 with the same id.
  - Send `{"input":"b"}` with key K: 409.
  - Restart the server and repeat: still 200 or 409.
- **Progress:** submit `steps:20` and poll `GET /api/jobs/:id`. `progress.completed` should increase, and the run should take about 2 s.
- **Retries:**
  - `failAttempts:2` should end `completed` with `attempts:3`.
  - `failAttempts:3` should end `failed`, `error:"transient failure"`, `attempts:3`, `result:null`.
- **Crash recovery:** start a `steps:20` job, `kill -9` the worker mid-run, then restart it. The job should finish. Completed jobs should stay untouched (`attempts` unchanged).
- **404/405:** `GET /nope` returns 404 JSON. `DELETE /api/jobs` and `POST /health` return 405. `GET /api/jobs/unknown` returns 404 `not_found`.
- **UI:** open `/`, submit a job, and watch status and progress update. Submit an empty input: form-error should show "input".

## Risks
- **Import extensions:** imports must stay as `./db.ts` (tsconfig rewrites them). The UI path `../ui/index.html` is relative to `dist/`, and that already works.
- **`node:sqlite` binding:** pass `null`, not `undefined`, as a parameter. Use `db.prepare(...).get/all/run`. Rows come back as null-prototype objects, so map them explicitly.
- **Heartbeat during long steps:** don't block the heartbeat. Use `setInterval` with async sleeps, never synchronous busy loops.
- **Attempt counting:** check whether the attempt fails before the first step's progress update, and count attempts at claim time. That keeps `attempts` exactly 3 on final failure.
- **Ordering:** order by `seq`/rowid, not `created_at`. Jobs created in the same millisecond would tie and break newest-first and oldest-first.
- **Content-Type check:** use a prefix match (with charset). The checks send `application/json` exactly.
- **Worker exit:** an open interval or pending timer keeps the worker alive after SIGTERM. Clear the interval and call `process.exit(0)` explicitly.
- **Lock errors:** wrap write transactions in try/catch and retry the loop on `SQLITE_BUSY`, rather than crashing.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
