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
Put the SQLite schema and the shared job helpers in `src/db.ts`. The server (`src/server.ts`) and the worker (`src/worker.ts`) both open the same database file and create the schema at startup with `CREATE TABLE IF NOT EXISTS`, so either can start first. The server is a plain `node:http` router that validates requests and enforces idempotency with a UNIQUE column. The worker is a single loop: it polls for jobs, claims one inside a `BEGIN IMMEDIATE` transaction, runs the steps with `await sleep(100)`, writes progress after each step, and writes a heartbeat row every 500 ms. The UI is one static `ui/index.html` with vanilla JS that polls `GET /api/jobs` every second. A job's status, attempts, progress, retry time and result are all stored in the database, so a crash or restart recovery only needs a few SQL statements.

## Files
- `src/db.ts`: keep `openDatabase` (it already does mkdir, busy_timeout and WAL). Add schema creation, the `JobRow` type, `rowToJob(row)` to produce the API JSON shape, `nowIso()`, and heartbeat helpers.
- `src/server.ts`: rewrite: router, body reading, validation, idempotency, error helpers, `GET /` serving `ui/index.html`, SIGTERM handling.
- `src/worker.ts`: rewrite: recovery at startup, heartbeat, claim/process loop, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, polling script.

## Steps
1. **Schema** (in `db.ts`, exported as `initSchema(db)` and called by both processes right after `openDatabase`):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL,
     input TEXT NOT NULL,
     steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0,
     result_output TEXT,
     error TEXT,
     idempotency_key TEXT UNIQUE,
     payload TEXT NOT NULL,
     next_run_at INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS worker_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), last_seen INTEGER NOT NULL);
   ```
   `next_run_at` is epoch ms. `payload` is the canonical JSON `JSON.stringify({input, steps, failAttempts})`, always with keys in that order and defaults applied.
2. **`rowToJob`** returns:
   `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`
   Timestamps come from `new Date().toISOString()`.
3. **Server helpers**:
   - `send(res, status, body)` with `content-type: application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **Routing** (use `pathname` from `new URL(req.url, 'http://x')`):
   - `/`: GET serves the HTML. Any other method gets 405.
   - `/health`: GET. Any other method gets 405.
   - `/api/jobs`: GET lists jobs, POST creates one. Any other method gets 405.
   - `/^\/api\/jobs\/([^/]+)$/`: GET returns the job. Any other method gets 405.
   - Anything else gets 404 `not_found`.
   - Look up ids with a prepared statement. Wrap `decodeURIComponent` in try/catch and return 404 if it throws.
5. **Health**: read `last_seen` from `worker_heartbeat`. `worker` is `"up"` if `Date.now() - last_seen < 3000`, otherwise `"down"`.
6. **List**: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs: rows.map(rowToJob)}`.
7. **POST validation**, in order:
   - **Content-Type:** take `content-type` split on `;`, trimmed and lowercased. It must be `application/json` (accepting `*/*+json` is fine). Missing or anything else gives 400 with field `body`.
   - **Read the body:** cap at 1 MB; anything larger gives 400 `body`.
   - **Parse:** `JSON.parse` failure gives 400 `body`. If the result is not a plain object (`null`, an array, or a primitive), also 400 `body`.
   - **Field errors:** gather them into one array, then return them together:
     - Every key that is not `input`, `steps` or `failAttempts` is an error on that key.
     - `input`: missing, not a string, length 0 or over 1000, or `input.trim()===''` is an error.
     - `steps`: if present (`!== undefined`), it must satisfy `typeof v==='number' && Number.isInteger(v) && 1<=v<=20`.
     - `failAttempts`: same check with range 0–5.
     - If an `idempotency-key` header is present (including an empty string) and fails `/^[A-Za-z0-9_-]{1,128}$/`, add an error on field `Idempotency-Key`.
   - If any errors: 400 `{error:{code:'invalid_request', message:'Invalid request', fields}}`.
8. **Create**: apply defaults (steps 5, failAttempts 0) and build `payload`.
   - **With a key:** look up `SELECT * FROM jobs WHERE idempotency_key=?`.
     - Found with the same `payload`: 200 with that job.
     - Found with a different payload: 409 `idempotency_conflict`.
     - Not found: insert and return 201.
     - `DatabaseSync` is synchronous and the server is single-threaded, so check-then-insert cannot race. The UNIQUE constraint protects across restarts. Still catch a UNIQUE error and fall back to the lookup.
   - **Insert values:** `id = crypto.randomUUID()`, `status='queued'`, `attempts=0`, `progress_completed=0`, `next_run_at=Date.now()`.
9. **Worker startup**:
   - Open the db and call `initSchema`.
   - **Recovery:** `UPDATE jobs SET status='queued', progress_completed=0, next_run_at=<now>, updated_at=? WHERE status='running'`. Only one worker exists, so any `running` row is orphaned.
   - Write a heartbeat immediately, then `setInterval` every 500 ms using `INSERT ... ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`.
   - Log `worker started`.
10. **Worker loop** (`while (!stopping)`):
    - **Claim:** in `BEGIN IMMEDIATE`, `SELECT id FROM jobs WHERE status='queued' AND next_run_at<=? ORDER BY seq ASC LIMIT 1`.
      - If found: `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=?`, then COMMIT. Roll back on error.
      - If nothing found: `await sleep(200)` and loop again.
    - **Process:** reload the row and set `n = attempts`.
      - **Transient failure** (`n <= fail_attempts`): `await sleep(100)`. Then:
        - If `n >= 3`: set `status='failed'`, `error='transient failure'`, `result_output=NULL`.
        - Otherwise: set `status='queued'`, `next_run_at=now+500`.
        - In both cases leave `progress_completed` at 0.
      - **Success path:** loop `for i in 1..steps`:
        - `await sleep(100)`.
        - If `stopping`, break out and requeue (see step 11).
        - Otherwise `UPDATE progress_completed=i, updated_at`.
      - **Completion:** set `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`, `error=NULL`.
      - Every write also sets `updated_at`.
11. **Worker SIGTERM/SIGINT**:
    - Set `stopping=true`.
    - If a job is mid-run: `UPDATE jobs SET status='queued', progress_completed=0, next_run_at=now WHERE id=? AND status='running'`. `attempts` stays incremented, because an attempt was started.
    - `clearInterval` the heartbeat, set `last_seen=0` so health shows down at once, call `db.close()`, then `process.exit(0)`.
    - Because the loop checks `stopping` after every 100 ms sleep, shutdown takes at most about 200 ms.
12. **Server SIGTERM/SIGINT**: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Add an `unref`'d 2-second fallback `setTimeout(() => process.exit(0))`.
13. **UI** (`ui/index.html`):
    - **Form:** `<form data-testid="job-form" novalidate>`. `novalidate` is essential so out-of-range values reach the API and its errors show.
    - **Inputs:**
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
      - Do not put `required`, `min` or `max` on them.
    - **Error region:** `<div data-testid="form-error" role="alert"></div>`, empty by default.
    - **List:** `<ul data-testid="job-list">`.
    - **Submit handler:**
      - `preventDefault`.
      - Build the body: `{input: inputEl.value}`. For each numeric field, if `value.trim() !== ''`, set `body.steps = Number(value)` (and likewise `failAttempts`). `NaN` serialises to `null`, which the API rejects with the field name.
      - POST with `Content-Type: application/json`.
      - If the response is not ok: set the error region's textContent to the message plus each `field: message` from `error.fields`, for example `Invalid request — steps: must be an integer from 1 to 20`.
      - On success: clear the error region, clear the input, call `refresh()`.
    - **refresh():**
      - Run every 1000 ms with `setInterval` and once on load.
      - Fetch `/api/jobs` and rebuild the list in API order (newest first).
      - Each job is `<li data-testid="job-item" data-job-id=ID>` containing spans `job-status` (status), `job-progress` (`${completed}/${total}`), `job-result` (`result?.output ?? error ?? ''`) and the input text.
      - Use `textContent` only, never innerHTML with user data.
14. Run `npm run build`, `npm run check:smoke`, `npm run check:contract`.

## Behaviours to verify
- **Build and start:** `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/t/x.db npm run start:server` and `start:worker` in either order. The `/tmp/t` directory gets created.
- **Health:** `curl localhost:3100/health` shows `worker:"up"`. Kill the worker; within 3 seconds it shows `"down"`.
- **Create:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":3}'` returns 201, status queued, attempts 0, progress `0/3`.
- **Progress:** poll `GET /api/jobs/:id` and watch `progress.completed` climb, ending `completed` with `HI`.
- **Retries:** `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with `error` `"transient failure"`, attempts 3, result null.
- **Validation:** each of these returns 400 `invalid_request` with the right field:
  - `steps:"3"` (field `steps`)
  - `steps:2.5` (field `steps`)
  - `{"input":"   "}` (field `input`)
  - a 1001-character input (field `input`)
  - `{"input":"a","x":1}` (field `x`)
  - `[]`, `nul`, or no content-type (field `body`)
  - `Idempotency-Key: bad key!` (field `Idempotency-Key`)

  Afterwards the job count is unchanged.
- **Idempotency:** with the same key, `{"input":"a"}` followed by `{"input":"a","steps":5,"failAttempts":0}` returns 200 with the same id. A different input with the same key returns 409. Restart the server and replay: still 200 and the same id.
- **Routing:** `/nope` returns 404 `not_found`. `DELETE /api/jobs` and `POST /health` return 405 `method_not_allowed`. `GET /api/jobs/zzz` returns 404.
- **Crash recovery:** submit `steps:20`, `kill -9` the worker mid-run, restart it. The job resumes and completes. Kill the server too and restart; all jobs are listed.
- **Graceful stop:** SIGTERM on both processes; each exits with code 0 in under 2 seconds.
- **UI:** in a browser, submit; the item appears and its status and progress update without a reload. Submit steps=0 and the alert shows text containing `steps`.
- **Checks:** `npm run check:contract` and `npm run check:smoke` pass.

## Risks
- **Imports:** source imports use `.ts` extensions (`./db.ts`). `rewriteRelativeImportExtensions` handles that, so keep the convention. The HTML path `new URL('../ui/index.html', import.meta.url)` resolves correctly from `dist/`.
- **Schema setup:** both processes must run `initSchema`. Without it, the worker starting first finds no table. `busy_timeout` is already set before WAL. Keep claim transactions short and never hold a transaction across an `await`.
- **Type checks:** `typeof v === 'number'` rejects numeric strings. Also reject `NaN` and `Infinity`, which `Number.isInteger` a
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
