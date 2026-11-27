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
Use one SQLite schema, created by both processes when they start (`src/db.ts`), with a `jobs` table and a single-row `worker_heartbeat` table. The server is a plain `node:http` router. It validates requests strictly, handles idempotency with a UNIQUE column inside a `BEGIN IMMEDIATE` transaction, and serves a static HTML page. The UI is plain JS that polls `GET /api/jobs` every second. The worker is a loop. It writes a heartbeat about every second, takes the oldest queued job that is due inside a transaction, runs the steps with a ~100 ms sleep each, and writes progress after every step. It handles retries through a `run_after` timestamp. When it starts, it puts any job left `running` by a dead worker back in the queue. Keep the existing `./db.ts` import style (`rewriteRelativeImportExtensions` is on) and keep reading `../ui/index.html` relative to `dist/server.js`.

## Files
- `src/db.ts`: keep `openDatabase`. Add `ensureSchema(db)`, which `openDatabase` calls. Add shared helpers: the `JobRow` type, `rowToJob(row)` (maps to the API JSON shape) and `nowIso()`.
- `src/server.ts`: rewrite as router, validation, idempotency, health and UI serving, plus SIGTERM handling.
- `src/worker.ts`: rewrite as heartbeat, recovery, claim loop, step processing, retries, plus SIGTERM handling.
- `ui/index.html`: form, error region and job list with the required `data-testid`s, plus inline script.

## Steps
1. **Schema** (`CREATE TABLE IF NOT EXISTS`, run after the existing PRAGMAs):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload TEXT)`.
   `worker_heartbeat(id INTEGER PRIMARY KEY CHECK (id=1), beat_at INTEGER NOT NULL)` stores epoch milliseconds.
   `rowToJob` sets `result` to `{output}` only when status is completed, and `error` only when failed. Otherwise both are null.
2. **Server helpers:** `send(res, status, body)` always sets `content-type: application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)`. `readBody(req)` collects the body as a string and caps it at about 1 MB; above the cap it returns 400 `invalid_request` with field `body`.
3. **Routing** on `pathname`:
   - `/` takes GET (serves the HTML).
   - `/health` takes GET.
   - `/api/jobs` takes GET and POST.
   - `/api/jobs/<id>` takes GET. Match it with `^/api/jobs/([^/]+)$` and decode the id.
   - A known path with the wrong method returns 405 `method_not_allowed` with an `Allow` header.
   - Anything else returns 404 `not_found`.
   - Wrap the handler in try/catch so an unexpected error returns 500 `internal_error`.
4. **Validation for POST** (collect every error into `fields`, then return 400 `invalid_request` if there are any):
   - Content-Type: split on `;`, trim and lowercase. If it is not `application/json`, or the header is missing, add a `body` error and do not parse the body.
   - Idempotency-Key: if the header is present (including an empty string), it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add field `"Idempotency-Key"`. Check this even when the body is also invalid.
   - `JSON.parse` failure → `body`. A result that is null, an array or not an object → `body`.
   - Each key not in {input, steps, failAttempts} → an error with that key as the field.
   - `input`: must be present and `typeof input === 'string'`, with `1 <= length <= 1000` and `input.trim().length > 0`. Store it untrimmed.
   - `steps` and `failAttempts` (if present, `undefined` aside): must be `typeof === 'number'`, `Number.isInteger`, and within range. A value of `null` is a type error.
   - Apply defaults: steps 5, failAttempts 0.
5. **Create and idempotency:** `payload = JSON.stringify({input, steps, failAttempts})` in that fixed key order.
   - With a key: `BEGIN IMMEDIATE`, then `SELECT` by `idempotency_key`.
     - If a row exists, COMMIT and return 200 with that job if its payload matches, or 409 `idempotency_conflict` if it doesn't.
     - Otherwise INSERT, COMMIT and return 201.
     - On an exception, ROLLBACK.
   - Without a key: plain INSERT with `idempotency_key` NULL (multiple NULLs are allowed under UNIQUE).
   - Set `id = crypto.randomUUID()`, status `queued`, `run_after = 0`, and `created_at`/`updated_at` to now as ISO strings.
6. **GET routes:** `GET /api/jobs` uses `ORDER BY seq DESC`. `GET /api/jobs/:id` returns the job or 404 `not_found`. `GET /health` reads `beat_at`; `worker` is `up` iff a row exists and `Date.now() - beat_at < 3000`.
7. **Server SIGTERM/SIGINT:** call `server.close()` and `server.closeAllConnections()` (polling keep-alive connections would otherwise hang), then `db.close()` and `process.exit(0)`. Add a 2 s fallback exit timer, `unref`'d.
8. **Worker startup:**
   - Open the db.
   - Write a heartbeat immediately (`INSERT ... ON CONFLICT(id) DO UPDATE`), then every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is redone under the same number, so the total never exceeds 3 and `failAttempts` semantics still hold.
9. **Worker loop** (`while (!stopping)`):
   - Claim: `BEGIN IMMEDIATE`, then `SELECT * FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq LIMIT 1`. If found, `UPDATE` it to status `running`, `attempts = attempts+1`, `progress_completed = 0`, `updated_at`, then COMMIT.
   - If nothing was claimed, sleep 200 ms.
   - Process the claimed job with attempt number `n = attempts+1`:
     - **Failure** (`n <= fail_attempts`): sleep about 100 ms (the first step) with no progress write.
       - If `n >= 3`: set status `failed`, `error='transient failure'`, `result_output` NULL.
       - Otherwise: set status `queued`, `run_after = Date.now()+500`, `progress_completed = 0`.
     - **Success:** for i in 1..steps, sleep 100 ms and then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps. Finally set `completed`, `result_output = input.toUpperCase()`, `progress_completed = steps`.
10. **Worker SIGTERM:** set `stopping`, and use an AbortController to abort the current sleep (pass `{signal}` to `timers/promises` sleep and catch `AbortError`). Put the in-flight job back in the queue the same way recovery does (attempts-1, queued). Delete the heartbeat row, clear the interval, `db.close()`, `process.exit(0)`.
11. **UI (`ui/index.html`):**
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - Do **not** put `required`, `min`, `max` or `step` attributes on these inputs, because they would block submission and stop the API's validation from running.
    - `<div data-testid="form-error" role="alert"></div>`, empty by default.
    - `<ul data-testid="job-list">`.
    - On submit: `preventDefault`. Build the body as `{input: value}` plus `steps: Number(v)` and `failAttempts: Number(v)` when the field is non-empty. `NaN` serialises to null, which the API rejects, so that is fine. POST it with the `Content-Type: application/json` header.
      - If the response is not ok: render `error.message` plus one line per field, `"<field>: <message>"`.
      - If it is ok: clear the error text, then refresh the list.
    - `refresh()`: fetch `/api/jobs` and reconcile `<li data-testid="job-item" data-job-id>` elements in order. Each item contains spans for `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`), plus the input text. Set content with `textContent`, never innerHTML. Run it with `setInterval(refresh, 1000)` and once on load.

## Behaviours to verify
- Build and start: run `npm run build`, start either process first, and check that `curl localhost:3000/health` shows `worker: up` within about 1 s of the worker starting, and `down` about 3 s after you SIGKILL it.
- Happy path: POST `{"input":"hello","steps":3}` returns 201 with status queued. Polling GET shows running with progress rising, then completed with `result.output = "HELLO"` and `progress` at 3/3.
- Retries: `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with attempts 3, `error "transient failure"` and result null.
- Validation: each of the following returns 400 with the right field:
  - `steps:"3"`, `steps:2.5`, `steps:0`, `steps:21`, `failAttempts:6`
  - `input:"   "`, input of 1001 characters
  - an extra field
  - body `[]`, `null`, `{bad`
  - `text/plain` or no Content-Type
  - Idempotency-Key `"a b"`, or 129 characters

  Then check that the job count is unchanged.
- Idempotency: send the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}`. The first returns 201 and the second 200 with the same id. The same key with a different input returns 409. Repeat after restarting the server.
- Routes: `/nope` returns 404 `not_found`. `DELETE /api/jobs` and `POST /api/jobs/x` return 405. `GET /api/jobs/unknown` returns 404. Every response is JSON.
- Durability: submit a job with steps 20, SIGKILL the worker while the job is running, restart the worker, and check that the job completes and its `attempts` value is sane. SIGKILL both processes, restart them, and check that all jobs are still listed and completed jobs are unchanged.
- SIGTERM: `kill -TERM` makes each process exit with code 0 within about 1 s.
- UI: open `/`, submit the form, and watch the item's status and progress update without reloading. Submitting steps 99 shows an alert containing "steps". Run `npm run check:smoke` and `npm run check:contract`.

## Risks
- **HTML validation attributes on the form:** they block the browser submit, so the API error never appears. Use `novalidate` and leave the inputs unconstrained.
- **Content-Type with parameters:** `application/json; charset=utf-8` must be accepted. Parse the media type instead of comparing the whole string.
- **Idempotency races and restarts:** rely on the DB UNIQUE constraint and the transaction, not on an in-memory map.
- **Newest-first ordering:** order by the `seq` autoincrement column, not by `created_at`, which can tie at millisecond resolution.
- **Recovery inflating attempts past 3:** decrement on requeue, as in step 8.
- **Hanging on shutdown:** keep-alive connections stall `server.close()`, and pending timers keep the worker alive. Use `closeAllConnections`, abortable sleeps and explicit `process.exit(0)`.
- **Lock errors:** `SQLITE_BUSY` can occur if `busy_timeout` is lost. Keep the existing PRAGMA order and keep transactions short and synchronous (no awaits inside BEGIN…COMMIT).
- **Reprocessing finished jobs:** completed and failed jobs must never be reprocessed. Claim only `status='queued'`, and make the progress and final UPDATEs include `WHERE id=? AND status='running'`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
