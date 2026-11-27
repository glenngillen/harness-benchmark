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
Build everything on the existing scaffold: `src/db.ts` holds the schema and shared row-to-JSON code, `src/server.ts` is a `node:http` API and also serves `ui/index.html`, and `src/worker.ts` is a polling loop. The two processes share state only through SQLite in WAL mode. Each multi-statement change runs inside `BEGIN IMMEDIATE … COMMIT`, so neither process sees half-finished state. The worker writes a heartbeat row every second, and `/health` checks it. Retries reuse the same job row: a failed attempt sets the job back to `queued` with a `run_after` time. When the worker starts, it puts any `running` jobs back in the queue.

## Files
- `src/db.ts`: keep `openDatabase`. Add `migrate(db)` (CREATE TABLE IF NOT EXISTS ×2), `Job` row types, `rowToJob(row)` for the exact API JSON shape, and `nowIso()`. Both processes call `migrate` at startup.
- `src/server.ts`: rewrite. Add routing, validation, idempotent create, list/get, health, JSON errors, and SIGTERM shutdown.
- `src/worker.ts`: rewrite. Add recovery on startup, heartbeat, a claim/process loop with retries, and SIGTERM shutdown.
- `ui/index.html`: a single page with inline JS (form, error region, job list that polls every second).
- Optional `src/validate.ts`: validation helpers. They can live in server.ts instead.

## Steps
1. **Schema** (`db.ts`):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,   -- epoch ms
     idem_key TEXT UNIQUE, payload TEXT);    -- canonical JSON of {input,steps,failAttempts}
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
   ```
   `rowToJob` returns `{id,status,input,steps,failAttempts,attempts,progress:{completed:progress,total:steps},result: status==='completed'?{output}:null, error: status==='failed'?error:null, createdAt, updatedAt}`. Keep `busy_timeout` and set it before WAL, as the file already does.
2. **Server helpers**: `send(res,status,body)` always sets `content-type: application/json; charset=utf-8`. `sendError(res,status,code,message,fields?)`.
3. **Routing**: parse the pathname from `new URL(req.url,'http://x')`.
   - `/` + GET → HTML.
   - `/health` + GET.
   - `/api/jobs` + GET or POST.
   - `/^\/api\/jobs\/([^/]+)$/` + GET.
   - Any other method on those known paths → 405 `method_not_allowed`, with an `Allow` header.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` on unexpected errors.
4. **Health**: `SELECT at FROM heartbeat WHERE id=1`. Return `worker: 'up'` if the row exists and `Date.now()-at < 3000`.
5. **POST validation**: read the whole body. Cap it at about 1 MB and return 400 on `body` if it is larger. Collect errors in a `fields` array, then:
   - **Idempotency-Key header**: if present, it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add field `"Idempotency-Key"`. If the header is an array, treat it as invalid.
   - **Content-Type**: take the media type before `;`, trim it, lowercase it, and require `application/json`. If it is wrong, add field `body` and do not parse the body.
   - **JSON**: `JSON.parse` in a try block. On failure, add field `body` ("malformed JSON"). The parsed value must be a non-null, non-array object, else add `body`.
   - **Unknown keys**: each key not in {input, steps, failAttempts} gets its own field entry.
   - **`input`**: must be present, `typeof === 'string'`, length 1–1000, and `trim() !== ''`.
   - **`steps` / `failAttempts`**: if present (`!== undefined`), require `typeof number`, `Number.isInteger`, and the range. Explicit `null` is invalid.
   - If `fields` is not empty, return 400 `invalid_request` with all of them.
6. **Create** (for the two-process case, use one transaction): build canonical `payload = JSON.stringify({input, steps, failAttempts})` with defaults applied and keys in that fixed order. Then run `BEGIN IMMEDIATE`:
   - If a key was sent, `SELECT * FROM jobs WHERE idem_key=?`. If a row exists and its payload matches, COMMIT and return 200 with that job. If the payload differs, COMMIT and return 409 `idempotency_conflict`.
   - Otherwise INSERT with `id=crypto.randomUUID()`, status `queued`, `run_after=0`, and both timestamps set to `nowIso()`. COMMIT and return 201.
   - ROLLBACK in a `catch`.
   - The UNIQUE constraint on `idem_key` backs this up.
7. **List and get**: list is `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. Get is by id, or 404 `not_found`.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a fallback `setTimeout(...,2000).unref()` exit.
9. **Worker startup**: open the DB, migrate, write the heartbeat (`INSERT … ON CONFLICT(id) DO UPDATE SET at=excluded.at`), and start `setInterval(heartbeat, 1000)`.
   - **Recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, run_after=0, updated_at=? WHERE status='running'`. Decrementing means the interrupted attempt is rerun with the same attempt number. Then `failAttempts` decides the same outcome, and the total stays capped at 3.
10. **Worker loop**: repeat until stopping.
    - **Claim** inside `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`. If found, `UPDATE … SET status='running', attempts=attempts+1, progress=0, updated_at=?`. COMMIT.
    - If nothing was claimed, `sleep(200)`.
    - **Process** with `n = attempts` after the increment:
      - **Fail branch** (`n <= fail_attempts`): sleep about 100 ms (the "first step"). If `n >= 3`, set status `failed` with `error='transient failure'`, `output=NULL`, progress 0. Otherwise set status `queued` with `run_after=Date.now()+500`, progress 0. Update `updated_at` either way.
      - **Success branch**: for i in 1..steps, `sleep(100)` and then `UPDATE progress=i, updated_at`. Check `stopping` between steps. At the end, set status `completed` with `output=input.toUpperCase()` and `progress=steps`.
11. **Worker shutdown**: the signal handler sets `stopping`. If a job is interrupted mid-run, give it the same treatment as recovery: queued, `attempts-1`, progress 0. Then clear the interval, delete the heartbeat row (optional), `db.close()`, and `process.exit(0)`. Add a 3 s fallback exit timer.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - `<textarea data-testid="job-input">` with no `required` attribute.
      - `<input data-testid="job-steps" value="5">` and `<input data-testid="job-fail-attempts" value="0">`. Use `type="text" inputmode="numeric"`, or `type="number"` with no min/max, so the browser never blocks a submission.
      - `<button data-testid="job-submit" type="submit">`.
      - `<div data-testid="form-error" role="alert">`, empty by default.
    - `<ul data-testid="job-list">`.
    - **Submit**: `preventDefault`. For each numeric field, an empty string means omit it. Otherwise send `Number(v)`; NaN turns into `null` in JSON and the API rejects it. POST with `content-type: application/json`.
      - If the response is not ok, set the error text to `error.message` plus each `field: message` from `error.fields`.
      - If it is ok, clear the error and refresh the list right away.
    - **Rendering**: `refresh()` fetches `/api/jobs` every 1000 ms and renders `<li data-testid="job-item" data-job-id=id>`, each containing `job-status`, `job-progress` (`${completed}/${total}`), `job-result` (output, error, or empty), and the input text. Build it with `textContent` only, never `innerHTML` with job data.
13. Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.

## Behaviours to verify
- **Build and start**: `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/t/x.db npm run start:server` and `start:worker` in either order. `curl /health` should show `"worker":"up"`. Stop the worker, and within about 3 s it should show `"down"`.
- **Create and progress**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hello","steps":3}'` → 201 queued. Poll `GET /api/jobs/:id` and watch `progress.completed` rise. It should end `completed` with `result.output` `"HELLO"`.
- **Retries**: `failAttempts:2` → completed with `attempts` 3. `failAttempts:3` → failed, `error` "transient failure", `attempts` 3, `result` null.
- **Validation**: each of these should return 400 `invalid_request` with the right field(s):
  - `{"input":"a","steps":"3"}`
  - `{"input":"   "}`
  - `{"input":"a","x":1}`
  - `[1]`
  - `{bad`
  - no Content-Type
  - `text/plain`
  - `steps:0`, `steps:21`, `steps:2.5`
  - `failAttempts:6`
  - `Idempotency-Key: bad key!`
- **Idempotency**: key K with `{"input":"a"}` → 201. Then `{"input":"a","steps":5,"failAttempts":0}` → 200 with the same id. Then `{"input":"b"}` → 409. Restart the server and repeat: still 200 and the same id.
- **Routing**: `DELETE /api/jobs` → 405. `GET /nope` → 404 JSON. `GET /api/jobs/zzz` → 404 `not_found`. Every response has an `application/json` content type, except `/`.
- **Crash recovery**: submit `steps:20`, `kill -9` the worker mid-run, restart it. The job should finish `completed`. Completed jobs keep their `updatedAt` (not reprocessed).
- **Graceful shutdown**: `kill -TERM` each process. Both should exit with code 0 within a few seconds.
- **UI**: open `/`, submit `steps=50`, and `form-error` should mention `steps`. Submit a valid job, and the item's status and progress should update without a reload.

## Risks
- **HTML route clashing with JSON routes**: only `GET /` returns HTML. Everything else must use the JSON helper, including 404, 405 and 500.
- **Node 22 `node:sqlite` API**: there is no `db.transaction()` helper, so use `db.exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK`. `get()` returns `undefined` when there is no row. Bind `null`, not `undefined`.
- **SQLITE_BUSY between processes**: keep `busy_timeout` and keep transactions short. Never `await` inside an open transaction.
- **Treating `0` as missing**: test `steps`/`failAttempts` with `!== undefined`, not truthiness, or `failAttempts: 0` breaks. `typeof NaN === 'number'` can't occur after JSON parsing, but still use `Number.isInteger`.
- **Attempt-count drift after a crash**: without the decrement in recovery, a crash could push `attempts` past 3 or rerun a fail-branch outcome differently. Make sure the "after the third failure" check uses `n >= 3`.
- **Heartbeat during long jobs**: the heartbeat must come from `setInterval`, not the claim loop. Step sleeps are async, so the timer still fires.
- **Newest-first ordering**: `createdAt` can tie, so sort by `seq`, never by timestamp.
- **Browser blocking the UI submission**: don't add `min`, `max` or `required` attributes. Use `novalidate`, or out-of-range values never reach the API.
- **Missing UI file at runtime**: the server runs from `dist/`, so resolve the UI with `new URL('../ui/index.html', import.meta.url)` as the scaffold does.
- **Forbidden files**: don't touch `package.json`, `tsconfig.json`, or anything in `checks/`. Imports must keep the `.ts` extensions, because `rewriteRelativeImportExtensions` is on.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
