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
Keep the current layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` is a `node:http` API that also serves `ui/index.html`, and `src/worker.ts` is a polling loop. Both processes open the same SQLite file through `openDatabase()`. Its existing busy_timeout/WAL setup stays, and it also runs `CREATE TABLE IF NOT EXISTS`, so either process can start first. All state changes that read and then write (idempotent insert, job claim) run inside `BEGIN IMMEDIATE` transactions. The worker writes a heartbeat row every 1 s, and `/health` compares it with the current time. The UI is one static HTML file with inline JS. It polls `GET /api/jobs` every 1 s and updates keyed DOM nodes.

## Files
- `src/db.ts`: keep `openDatabase`. Add the schema, a `Job` row type, `rowToJob()` (builds the API JSON shape), and small query helpers used by both processes.
- `src/server.ts`: routing, body reading, validation, idempotency, error shapes, 404/405, `/health` with heartbeat, SIGTERM shutdown.
- `src/worker.ts`: crash recovery at startup, heartbeat, claim loop, step processing, retries, SIGTERM shutdown.
- `ui/index.html`: form, error region, job list, polling script (the server reads it from `../ui/index.html` relative to `dist/`, which already works).

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, idempotency_key TEXT UNIQUE, payload TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`, an index on `(status, run_after, seq)`, and `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), ts INTEGER NOT NULL)`.
   - `rowToJob`: `progress: {completed: progress_completed, total: steps}`, `result: status==='completed' ? {output: result_output} : null`, `error: status==='failed' ? error : null`.
   - Timestamps come from `new Date().toISOString()`. Ids come from `crypto.randomUUID()`.
2. **Server helpers**:
   - `send(res, status, body)`: always `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body as a utf8 string, with a size cap of about 1 MB. Over the cap, return 400 with field `body`.
3. **Routing**: match the pathname exactly.
   - `/health` allows GET. `/` allows GET (HTML). `/api/jobs` allows GET and POST. `^/api/jobs/([^/]+)$` allows GET; decode the id with `decodeURIComponent` inside try/catch.
   - A known path with another method returns 405 `method_not_allowed`. Anything else returns 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` on failure.
4. **Validation for POST /api/jobs**: collect *all* field errors into `fields`.
   - Content-Type: take the media type before `;`, trim and lowercase it. It must equal `application/json`. If it doesn't, add field `body` and skip parsing.
   - `JSON.parse` fails: field `body`. Parsed value is not a plain object (null, array, primitive): field `body`.
   - Each unknown key is added as its own field.
   - `input`: must be a string with `1 <= length <= 1000` and `trim().length > 0`. Store it unchanged.
   - `steps` and `failAttempts`: if `undefined`, use the default. Otherwise require `typeof === 'number' && Number.isInteger(v)` and the range check. Strings like `"3"` are rejected.
   - The `Idempotency-Key` header (`req.headers['idempotency-key']`), if present, must match `^[A-Za-z0-9_-]{1,128}$`. If it doesn't, add field `Idempotency-Key`. Validate the key even when the body is invalid, and report everything together. Any error returns 400 `invalid_request` and creates no job.
5. **Create / idempotency**:
   - Build a canonical payload: `JSON.stringify({input, steps, failAttempts})`, after defaults, with the keys always in that order.
   - In `BEGIN IMMEDIATE`: if there is a key, `SELECT` by `idempotency_key`. If a row exists and its payload is equal, COMMIT and return 200 with that job. If the payload differs, return 409 `idempotency_conflict`.
   - Otherwise INSERT with status `queued`, attempts 0, and `run_after = 0`, then return 201.
   - Use try/catch with ROLLBACK. The UNIQUE constraint is the backstop that makes the guarantee hold across restarts.
6. **List / get**:
   - List: `SELECT * FROM jobs ORDER BY seq DESC`, returning `{jobs:[...]}`. Order by `seq`, not `created_at`, because two jobs can share a millisecond.
   - Get by id: 404 `not_found` if missing.
7. **Health**: read `heartbeat.ts`. Return `worker: 'up'` if the row exists and `Date.now() - ts < 3000`.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a fallback `setTimeout(...).unref()` that exits.
9. **Worker startup**:
   - Write the heartbeat immediately, then every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is not counted, so the retry rules stay consistent and the job can never exceed 3 attempts.
   - Completed and failed jobs are never touched.
10. **Worker loop**: `while (!stopping)`.
    - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq LIMIT 1`, then `UPDATE ... SET status='running', attempts=attempts+1, progress_completed=0, error=NULL, result_output=NULL, updated_at=now`. COMMIT.
    - If nothing was claimed, `sleep(200)` and loop again.
    - Process the claimed job with `n = attempts`:
      - If `n <= fail_attempts`, the attempt fails before any progress. If `n >= 3`, set `status='failed', error='transient failure', result_output=NULL`. Otherwise set `status='queued', run_after=Date.now()+500, progress_completed=0`.
      - Otherwise, for `i` in `1..steps`: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. After the loop: `status='completed', result_output=input.toUpperCase()`.
    - Every UPDATE after the claim adds `WHERE id=? AND status='running'`.
    - On SIGTERM, finish the current job (at most about 2 s), then exit the loop. Then `clearInterval`, delete the heartbeat row (so health reports down quickly), `db.close()`, and `process.exit(0)`.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing `input[type=text][data-testid=job-input]`, `input[type=number][data-testid=job-steps] value=5`, `input[type=number][data-testid=job-fail-attempts] value=0`, and `button[type=submit][data-testid=job-submit]`.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list"></ul>`.
    - On submit: `preventDefault`. Build the body with `input` as a raw string. For each numeric field: empty means omit it; `Number(v)` if finite, otherwise send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`. If the response is not ok, set form-error textContent to `message` plus a `field: message` line for each entry in `fields`. If it is ok, clear form-error and refresh immediately.
    - Poll `/api/jobs` every 1000 ms. Keep a map from id to `<li data-testid="job-item" data-job-id>` containing spans `job-status`, `job-progress` (`${completed}/${total}`), and `job-result` (output if completed, error if failed, otherwise `''`).
    - Reorder or prepend so the list matches the API order (newest first). Use `textContent` only, never innerHTML with user data.
    - Do not re-render the form while polling.

## Behaviours to verify
- Build and checks: run `npm run build`, then `npm run check:smoke` and `npm run check:contract` (read `checks/cli.ts` for how it launches the processes and which env vars it uses).
- Startup order: start the server only and `curl /health`; it should report `worker:"down"`. Start the worker; within about 1 s it reports `up`. Kill the worker; within 3 s it reports `down`.
- Create: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}' localhost:3000/api/jobs` returns 201 queued. Poll `GET /api/jobs/:id` and watch progress go 0→3, then `completed` with output `HI`.
- Validation:
  - `{"input":"x","steps":"2"}` → field `steps`.
  - `failAttempts: 7` → `failAttempts`.
  - `colour` → `colour`.
  - missing input → `input`.
  - `"   "` → `input`.
  - `[]`, `nul`, text/plain → `body`.
  - Bad key `a b` → `Idempotency-Key`.
  - The job count is unchanged after all of these.
- Idempotency: same key and payload `{"input":"a"}`, then `{"input":"a","steps":5,"failAttempts":0}` → the second returns 200 with the same id. Same key with a different input → 409. Restart the server and replay the first request → 200 with the same id.
- Retries: `failAttempts:1, steps:1` → completed, attempts 2. `failAttempts:2` → attempts 3, completed. `failAttempts:3` → failed, `error:"transient failure"`, attempts 3, result null. Exactly one job is listed each time.
- Crash recovery: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job completes within a few seconds. Completed jobs keep their `updatedAt`.
- 404/405: `GET /nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `POST /health` → 405.
- UI: open `/` and submit valid and invalid jobs. The list updates live, and form-error shows field names on rejection.
- SIGTERM: `kill -TERM` each process; it exits with code 0 quickly.

## Risks
- **Imports**: keep the `./db.ts` import style (tsconfig has `rewriteRelativeImportExtensions`), and don't use TS-only syntax that strip-types can't handle (enums, parameter properties), in case the checks import it.
- **SQLite locking**: the server and worker write at the same time, so keep transactions short, always ROLLBACK in `catch`, and never `await` inside a transaction. `node:sqlite` is synchronous, so this is easy as long as you never sleep between BEGIN and COMMIT.
- **Retry backoff**: blocking the loop with the sleep would stall other jobs. Store `run_after` instead, and query with `run_after <= now`.
- **Default values**: `typeof null === 'object'` and `steps: null` must be rejected. Only `undefined` gets the default.
- **Numeric validation**: `Number.isInteger(2.0)` is true. That is fine, because JSON can't tell `2.0` from `2`.
- **Content-Type**: use a strict media-type comparison; `application/json; charset=utf-8` must be accepted.
- **Error responses**: every error path, including 404/405/500, must return JSON with the `{error:{code,message}}` shape.
- **Job order**: use `seq`, not timestamps, so the ordering is deterministic.
- **Recovery accounting**: a recovered job must not go over 3 attempts or skip its fail logic. The decrement in step 9 handles this. Never reset `attempts` on normal retries.
- **UI polling**: don't rebuild the whole list with innerHTML, because that can drop the evaluator's element references. Update nodes in place. Keep form-error truly empty (`''`) on success.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
