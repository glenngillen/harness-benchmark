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
Keep the current layout: `src/db.ts` (shared schema and helpers), `src/server.ts` (node:http API and the UI page) and `src/worker.ts` (polling loop), plus `ui/index.html` (plain JS, no framework). Both processes call `openDatabase()`, which sets up the schema with idempotent `CREATE TABLE IF NOT EXISTS` statements. The two processes share only a `jobs` table and a `worker_heartbeat` table. The worker claims the next job with one atomic `UPDATE … RETURNING`, writes progress after every step, and schedules retries with a `run_after` timestamp. At startup it puts orphaned `running` jobs back in the queue. Idempotency uses a UNIQUE `idempotency_key` column plus a stored canonical payload, checked inside a `BEGIN IMMEDIATE` transaction.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add the schema, a `JobRow` type, `rowToJob(row)` that builds the exact API JSON shape, and `nowIso()`.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotency, health and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: form, error region, job list and polling script, all with the required `data-testid`s.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas, in one `db.exec`):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload TEXT NOT NULL)`, plus an index on `(status, run_after, seq)`.
   `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL)`, where `last_seen` is epoch ms.
   `rowToJob` returns `{id,status,input,steps,failAttempts,attempts,progress:{completed,total:steps},result: status==='completed'?{output}:null, error: status==='failed'?error:null, createdAt, updatedAt}`.
2. **Server helpers:** `send(res,status,body)` always sends `application/json; charset=utf-8`. `sendError(res,status,code,message,fields?)`. Read the body as a utf8 string, capped at about 1 MB (anything bigger is a 400 on `body`).
3. **Routing** (on `pathname`):
   - `/health` → GET.
   - `/` → GET serves the HTML. Read it from `new URL('../ui/index.html', import.meta.url)` as the current code does.
   - `/api/jobs` → GET or POST.
   - `/^\/api\/jobs\/([^/]+)$/` → GET. Run `decodeURIComponent` on the id.
   - A known path with the wrong method → 405 `method_not_allowed` with an `Allow` header. Anything else → 404 `not_found`.
   - Wrap the handler in try/catch so unexpected errors return 500 `internal_error` as JSON.
4. **Health:** `SELECT last_seen FROM worker_heartbeat WHERE id=1`. Report `worker: "up"` if `Date.now()-last_seen < 3000`.
5. **POST validation:** collect every error into a `fields` array, then return 400 `invalid_request` if the array is non-empty.
   - Content-Type: take the media type before `;`, trimmed and lowercased. It must be `application/json`. If it is missing or different, push `{field:"Content-Type"}` **and** `{field:"body"}`.
   - JSON: if `JSON.parse` fails, push `body`. If the result is not a plain object (null, an array or a primitive), push `body`.
   - Fields: each key not in {input, steps, failAttempts} → push that key name.
   - `input`: must be present, `typeof==='string'`, `length` 1–1000, and `trim()!==''`.
   - `steps` and `failAttempts`: if the key is present (`!== undefined`), the value must be `typeof==='number' && Number.isInteger(v)` and in range. `null` and `"3"` are rejected.
   - `Idempotency-Key`: if the header is present (`req.headers['idempotency-key']`), test it against `/^[A-Za-z0-9_-]{1,128}$/`. If it fails, push field `"Idempotency-Key"`. Collect this together with the body errors.
6. **Create:** build the canonical payload `JSON.stringify({input, steps, failAttempts})` with defaults applied, in a fixed key order.
   - Run `BEGIN IMMEDIATE`. If there is a key, `SELECT` by `idempotency_key`. On a hit, `COMMIT`, then return 200 with the job if the payload matches, or 409 `idempotency_conflict` if it differs.
   - Otherwise `INSERT` with `id=randomUUID()`, status `queued`, both timestamps set to `new Date().toISOString()`, and `run_after=0`. `COMMIT` and return 201. `ROLLBACK` on any error.
   - If the insert fails on the UNIQUE constraint, re-select and apply the same comparison.
7. **List and get:** `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. Get by id → the job or 404 `not_found`.
8. **Server shutdown:** on SIGTERM and SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a fallback `setTimeout(...,2000).unref()` that also exits.
9. **Worker startup:**
   - Write the heartbeat right away, then every 1000 ms with `setInterval`, using `INSERT … ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run under the same attempt number. That keeps the total at 3 or fewer and gives the same failure outcome, because a failing attempt fails before any progress. Recovery is safe because there is only one worker.
10. **Worker loop:** while not stopping, claim a job:
    `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, error=NULL, updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
    If nothing comes back, `await sleep(200)`. Otherwise process the job:
    - If `attempts <= fail_attempts`:
      - If `attempts < 3`, set `status='queued'`, `run_after=Date.now()+500` and `progress_completed=0`.
      - Otherwise set `status='failed'`, `error='transient failure'` and `result_output=NULL`.
    - Otherwise, for each step i from 1 to steps: `await sleep(100)`. If stopping, break out and requeue (see step 11). Otherwise `UPDATE progress_completed=i, updated_at`. Combine the last step with completion in one UPDATE: `status='completed'`, `progress_completed=steps`, `result_output=input.toUpperCase()`.
    - Guard every update with `WHERE id=? AND status='running'`.
11. **Worker SIGTERM:** set `stopping=true`. The loop finishes its current step sleep, puts the in-flight job back in the queue (same SQL as recovery, but for that id), clears the interval, calls `db.close()` and exits 0. Add a 3 s fallback exit.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" type="text">`
      - `<input data-testid="job-steps" type="number" value="5">`
      - `<input data-testid="job-fail-attempts" type="number" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - **Do not** use `required`, `min`, `max` or `maxlength` on these inputs.
    - Below the form: `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.
    - Submit handler: call `preventDefault`. Build `{input: inputEl.value}`. For each numeric field, if the trimmed value is non-empty, add `Number(value)`; if `Number` gives NaN, send the raw string so the API rejects it. Send a POST with `Content-Type: application/json`.
    - If the response is not ok, show `error.message` and one line per `fields` entry as `"<field>: <message>"`. On success, clear the error region and the text input, then refresh right away.
    - Poll `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>` containing `job-status`, `job-progress` (`completed/total`), and `job-result`: the output if completed, the error if failed, empty otherwise.
    - Use `textContent` only, never innerHTML with job data. Rebuild only the list, never the form.

## Behaviours to verify
- Build and start: `npm run build`, then start both processes in either order with a temporary `DATABASE_PATH` in a missing directory. Both should log within 10 s.
- Official checks: `npm run check:smoke` and `npm run check:contract` both pass.
- Health: `curl localhost:3000/health` shows `up` while the worker runs, and `down` about 3 s after the worker is killed.
- Validation:
  - `{"input":"a","steps":"2"}` → 400 with field `steps`.
  - `{"input":"a","colour":"x"}` → field `colour`.
  - `{"steps":2}` → field `input`.
  - `"   "`, malformed JSON, `[]`, a `text/plain` Content-Type and a bad `Idempotency-Key` are all 400s.
  - None of these creates a job (compare the `GET /api/jobs` count).
- Idempotency: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` → 201 then 200 with the same id. A different input → 409. Restart the server and replay → 200 with the same id.
- Processing: `steps:5` → poll during processing and see progress climb, then `completed` with `INPUT` and `attempts 1`. `failAttempts:2` → completed with `attempts 3`. `failAttempts:3` → `failed`, error `"transient failure"`, `attempts 3`, `result null`.
- Crash recovery: submit `steps:20`, `kill -9` the worker partway through, restart it. The job completes within about 10 s, and completed jobs are not re-run (their `updatedAt` is unchanged).
- Shutdown: `kill -TERM` each process. Each exits promptly with code 0.
- UI: open `/`, submit a valid job and watch status and progress update. Submit `steps` 50 and check that `form-error` shows "steps".

## Risks
- Browser-side validation attributes (`min`/`max`/`required`) would block a bad submission, so the API rejection never appears in `form-error`. Use `novalidate` and leave those attributes off.
- Failing to collect the Idempotency-Key and Content-Type errors with the right field names. Put the field name in `fields` exactly as written above.
- Using `!body.steps`-style checks would let `0` or `null` through, or wrongly reject them. Use explicit `=== undefined` and type checks.
- Ordering by `created_at` alone makes ties ambiguous. Order by `seq DESC`.
- Recovery or SIGTERM requeueing that increments `attempts` past 3, or that re-runs completed jobs. Requeue only `status='running'`, and decrement `attempts` when doing so.
- Blocking the worker's event loop would stop heartbeats. Use only `await sleep`, never a busy-wait.
- Keep the `.ts` extensions on relative imports (the tsconfig rewrites them). The `node:sqlite` `RETURNING` result comes from `stmt.get()`.
- The server must send `application/json` for every error, including 404, 405 and 500, as well as for the health check.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
