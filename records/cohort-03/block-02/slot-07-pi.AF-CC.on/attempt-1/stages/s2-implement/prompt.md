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
Keep the existing three-file layout (`src/db.ts`, `src/server.ts`, `src/worker.ts`) and the single page `ui/index.html`. `db.ts` owns the schema and all SQL helpers, and both processes use it. The server validates requests, handles idempotency inside a SQLite transaction, and maps rows to the job JSON shape. The worker sends a heartbeat on a timer and runs a polling loop. Each loop claims the oldest queued job that is due, runs its steps with `await sleep(100)`, and writes progress after each step. Retries use a `run_after` timestamp column. Jobs left in `running` after a crash are reset to `queued` when the worker starts. The UI is plain HTML/JS: it calls `/api/jobs` every second and updates elements in place by `data-job-id`.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for `jobs`, `idempotency_keys` and `heartbeat`. Add `rowToJob(row)` and the shared query helpers. Both processes call schema creation, since either may start first.
- `src/server.ts`: routing, body reading, validation, idempotency, error responses, `/health` from the heartbeat, serving `/`, and SIGTERM shutdown.
- `src/worker.ts`: heartbeat interval, crash recovery at startup, claim/process loop, retries, and SIGTERM shutdown.
- `ui/index.html`: the form, the `form-error` alert region, the job list, and the polling script.

## Steps
1. **Schema** (in `db.ts`, `initSchema(db)` called from `openDatabase`):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
   - `idempotency_keys(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`
   - `heartbeat(name TEXT PRIMARY KEY, at INTEGER NOT NULL)`
   - `rowToJob` returns exactly these keys: `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
2. **Server helpers:** `send(res, status, body)` always uses `application/json; charset=utf-8`. Add `sendError(res, status, code, message, fields?)`. Wrap the handler in try/catch and return `500 internal_error` if anything throws.
3. **Routing** (on `pathname`):
   - `/` GET serves the HTML.
   - `/health` GET returns `{status:'ok', worker}`. `worker` is `'up'` if `Date.now() - heartbeat.at < 3000`, otherwise `'down'`. A missing row means `'down'`.
   - `/api/jobs`: GET lists jobs with `ORDER BY seq DESC`. POST creates a job.
   - `/^\/api\/jobs\/([^/]+)$/` GET returns the job or `404 not_found`.
   - A known path with any other method returns `405 method_not_allowed`. Everything else returns `404 not_found`.
4. **Reading the POST body:** read the full body as a utf8 string. Cap it at about 1 MB; past that, return 400 `invalid_request` with field `body`.
5. **POST validation.** Collect `fields` from all of these, then return one 400 if any exist:
   - **Content-Type:** take the header, split on `;`, trim and lowercase it. It must equal `application/json`. If it is missing or different, push `{field:'body', message:'Content-Type must be application/json'}` and skip parsing.
   - **Idempotency-Key:** if the header is present (including empty string) and does not match `/^[A-Za-z0-9_-]{1,128}$/`, push field `Idempotency-Key`.
   - **Parse:** run `JSON.parse` in a try block. On failure push `body` "malformed JSON". If the result is not a plain object (null, an array or a primitive), push `body`.
   - **Object checks:**
     - Each unknown key gets its own entry, with the key name as the field.
     - `input` must be `typeof string`, `length` 1–1000, and `trim() !== ''`. A missing `input` counts as an error.
     - `steps` and `failAttempts`: if the key is absent, apply the default. If present, the value must be `typeof number`, `Number.isInteger`, and within range. Reject `null` and `"3"`.
6. **Idempotency and insert:**
   - Canonical payload is `JSON.stringify({input, steps, failAttempts})`, in that fixed key order.
   - Run `BEGIN IMMEDIATE` … `COMMIT`, with rollback on error.
   - If a key was given, look it up. If found with an equal payload, return `200` with the stored job. If found with a different payload, return `409 idempotency_conflict`.
   - Otherwise insert the job: `id = crypto.randomUUID()`, `status='queued'`, `attempts=0`, `progress=0`, `run_after=0`, and the same ISO time for both `created_at` and `updated_at`. Then insert the key row and return `201`.
7. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()`, then `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Listen on `PORT` (default 3000).
8. **Worker startup:**
   - Open the DB (this creates the schema).
   - Run recovery: `UPDATE jobs SET status='queued', progress=0, run_after=0, updated_at=? WHERE status='running'`.
   - Write the heartbeat right away (`INSERT … ON CONFLICT(name) DO UPDATE SET at=excluded.at`), then every 500 ms with `setInterval`. The step loop is async with sleeps, so the timer fires reliably.
9. **Worker loop**, while not stopping:
   - Claim: in one statement, `UPDATE jobs SET status='running', attempts=MIN(attempts+1,3), progress=0, updated_at=? WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
   - If nothing was claimed, `await sleep(200)` and loop again.
   - The `MIN(...,3)` cap matters. If a job crashed during attempt 3, that attempt had already passed its failure check (failures happen before any progress), so re-running with n=3 gives the correct outcome and `attempts` never goes above 3.
   - Process the claimed job with `n = attempts`:
     - **Failure branch** (`n <= fail_attempts`): wait one step (~100 ms) and fail without progress. If `n < 3`, set `status='queued'`, `run_after = now + 500`, `updated_at`. Otherwise set `status='failed'`, `error='transient failure'`, `output=NULL`.
     - **Normal branch:** for `i = 1..steps`, `await sleep(100)`, then `UPDATE progress=i, updated_at`. Stop early if `stopping`. After the last step, set `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
   - Every update includes `WHERE id=? AND status='running'` as a guard.
10. **Worker shutdown:** on SIGTERM/SIGINT, set `stopping=true`. The loop leaves after the current step and leaves the job `running`; recovery at the next startup re-queues it. Then clear the interval, delete the heartbeat row (or set `at=0`), call `db.close()` and `process.exit(0)`. Also add a fallback `setTimeout(() => process.exit(0), 2000).unref()`.
11. **UI** (`ui/index.html`):
    - The form uses `data-testid="job-form"` and `novalidate`. Fields:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`, with no min/max so the API does the validating
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - Add `<div data-testid="form-error" role="alert"></div>`, empty by default, and `<ul data-testid="job-list">`.
    - **On submit:** `preventDefault`. Build the body as `{input}`. For each numeric field, add `Number(value)` if the field is not blank; a blank field is omitted so the default applies. `fetch` POST with `content-type: application/json`.
    - **If the response is not ok:** fill form-error with `error.message` plus one line per `fields` entry, `"<field>: <message>"`, using textContent. On success, clear form-error, clear the input, and refresh the list right away.
    - **Polling:** `setInterval(refresh, 1000)` plus a first load on page start. `refresh` GETs `/api/jobs`. For each job, find or create `<li data-testid="job-item" data-job-id>` containing spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`). Keep the list in API order (newest first) by re-appending the items in order.

## Behaviours to verify
- **Build and start:** `npm run build`, then start the server and worker in either order with a temp `DATABASE_PATH=/tmp/x/jobs.db` (the directory should get created). `curl /health` should show `worker: up`. Stop the worker; within about 3 s it should show `down`.
- **Validation:** each of these should return 400 `invalid_request` with the right `fields`: no content-type, `text/plain`, `{bad`, `[]`, `"x"`, `{"input":"   "}`, `{"input":"a","steps":"3"}`, `{"steps":0}` (two fields: input and steps), `{"input":"a","x":1}`, a 1001-character input, and the header `Idempotency-Key: a b`. Confirm with `GET /api/jobs` that no job was created.
- **Idempotency:** `{"input":"a"}` with key K returns 201. `{"input":"a","steps":5,"failAttempts":0}` with K returns 200 and the same id. `{"input":"b"}` with K returns 409. Restart the server and repeat: still 200 with the same id.
- **Processing:** a job with `steps:5` shows `progress.completed` going up while polled every 100 ms, ends `completed` with uppercased output and `5/5`, and gets picked up within 1 s.
- **Retries:** `failAttempts:2` ends `completed` with `attempts:3`. `failAttempts:3` and `failAttempts:5` end `failed` with `attempts:3`, `error:"transient failure"` and `result:null`. The total job count does not change.
- **Crash recovery:** submit a job with `steps:20`, `kill -9` the worker mid-run, restart it, and confirm the job completes. `kill -9` the server too and confirm all jobs are still listed. Completed jobs keep their `updatedAt` after restarts.
- **SIGTERM:** both processes exit within about 1 s with code 0.
- **Checks:** run `npm run check:smoke` and `npm run check:contract`.
- **UI:** open `/`, submit a job, and watch status and progress update. Submit `steps` 50 and confirm form-error mentions `steps`.

## Risks
- **Wrong error code for 404 vs 405:** `/api/jobs/:id` with POST must return 405, not 404. An unknown `/api/foo` must return 404.
- **Content-Type with parameters:** `application/json; charset=utf-8` must be accepted, so split on `;` before comparing.
- **Defaults vs explicit nulls:** apply a default only when the key is absent (`!('steps' in body)`). An explicit `null` is an error.
- **Attempts going above 3 after a crash:** use the `MIN(attempts+1,3)` claim and the recovery that resets `running` to `queued`. Never leave a job stuck in `running`.
- **Lock errors when both processes start together:** keep busy_timeout before WAL, as the existing code does. Keep transactions short and fully synchronous, with no `await` inside a transaction.
- **ESM import paths:** keep imports as `./db.ts`. tsconfig's `rewriteRelativeImportExtensions` turns them into `.js`. The UI path `new URL('../ui/index.html', import.meta.url)` resolves from `dist/`, which works.
- **Duplicate jobs from idempotent POSTs:** do the key lookup and insert inside one `BEGIN IMMEDIATE` transaction. The key table's PRIMARY KEY is the final guard against duplicates.
- **UI re-renders breaking the evaluator:** update existing nodes instead of replacing all of them, so held references keep working. Use textContent, never innerHTML, for user input.
- **SIGTERM not exiting:** the worker's sleep loop and the heartbeat interval can keep the process alive. Clear the interval and call `process.exit` explicitly.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
