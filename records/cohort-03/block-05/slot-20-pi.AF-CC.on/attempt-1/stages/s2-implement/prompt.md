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
Use one SQLite schema, created idempotently by `openDatabase()` and shared by both processes. It has a `jobs` table and a single-row `heartbeat` table. The server is a plain `node:http` router. It does strict validation that collects every error, and idempotent inserts inside `BEGIN IMMEDIATE` transactions backed by a UNIQUE index on the idempotency key. The worker writes a heartbeat on a timer, puts any `running` jobs back in the queue at startup, and polls the queue every 200 ms. It claims the oldest queued job that is due using a single `UPDATE … RETURNING`, runs its steps with 100 ms sleeps, and writes progress after each step. Retries do not sleep in the worker: a failed attempt sets the job back to `queued` with a `run_after` timestamp. The UI is one static HTML file with vanilla JS. It reloads `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL) and add schema creation with `CREATE TABLE IF NOT EXISTS`. Also add shared helpers: the `JobRow` type, `rowToJob(row)` (builds the exact JSON shape), and `nowIso()`.
- `src/server.ts`: rewrite. Router, body reading, validation, idempotency, health check, UI serving, SIGTERM shutdown.
- `src/validate.ts` (new, optional): `validateSubmission(contentType, rawBody, idemKeyHeader)` returns `{ok, payload}` or `{ok:false, fields}`.
- `src/worker.ts`: rewrite. Heartbeat, recovery, claim loop, processing, retries, SIGTERM.
- `ui/index.html`: form, error region, job list, polling script.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
   ```
   Use positional `?` parameters, and pass `null` rather than `undefined` (node:sqlite rejects `undefined`). `rowToJob` returns: `result = status==='completed' ? {output: result_output} : null`, `error = status==='failed' ? error : null`, `progress = {completed: progress_completed, total: steps}`.
2. **Server routing.** Parse the pathname with `URL`. Known routes:
   - `/` (GET): send the HTML, read once at startup the way it is now.
   - `/health` (GET)
   - `/api/jobs` (GET, POST)
   - `/api/jobs/:id`, matching `^/api/jobs/([^/]+)$` (GET)
   
   A known path with the wrong method returns 405 `method_not_allowed` with an `Allow` header. Anything else returns 404 `not_found`. Wrap each handler in try/catch and send 500 `internal_error` on an exception. Every JSON response uses `application/json; charset=utf-8`.
3. **Health check.** `SELECT last_seen FROM heartbeat WHERE id=1`. `worker` is `"up"` if the row exists and `Date.now() - last_seen < 3000`.
4. **GET list and GET by id.** List with `SELECT * FROM jobs ORDER BY seq DESC`. Do not sort by `created_at`, because timestamps can tie. A missing id returns 404 `not_found`.
5. **POST validation.** Read the whole body, capped at about 1 MB (anything bigger gives `invalid_request` on `body`). Collect errors into `fields`:
   - Idempotency key: if the header is present and fails `/^[A-Za-z0-9_-]{1,128}$/`, add field `Idempotency-Key`. An empty header value counts as present and invalid.
   - Content-Type: take the part before `;`, trim it, lowercase it. It must be `application/json`. If it is missing or different, add `{field:"body"}` and also `{field:"Content-Type"}`, then return 400 without parsing.
   - Parse: `JSON.parse` fails → `body`. The result is not a plain object (null, array, or primitive) → `body`.
   - Unknown keys: one entry per key, using the key's name.
   - `input`: must be a string, `1 ≤ length ≤ 1000`, and `trim() !== ''`. If missing, add field `input`.
   - `steps` and `failAttempts`: if present, they must satisfy `typeof v==='number' && Number.isInteger(v)` and be in range. An explicit `null` is invalid. If absent, use the defaults 5 and 0.
   
   If any errors were collected, return `400 {error:{code:'invalid_request', message:'Invalid request', fields}}`.
6. **POST create and idempotency.** Build the canonical payload string `JSON.stringify({input, steps, failAttempts})` with fixed key order. Then `BEGIN IMMEDIATE`:
   - If a key was sent, select the row with that `idempotency_key`. Same `payload` → COMMIT and return 200 with that job. Different payload → COMMIT and return 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = randomUUID()` (from `node:crypto`), status `queued`, `created_at = updated_at = new Date().toISOString()`, `run_after = 0`, and `idempotency_key = key ?? null`. COMMIT, then return 201 with the job.
   
   Use try/catch around the transaction and ROLLBACK on error.
7. **Server shutdown.** On SIGTERM or SIGINT: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Log to stdout when listening.
8. **Worker startup.**
   - Open the DB.
   - Write the heartbeat right away (`INSERT … ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`), then every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is redone as the same attempt number, which keeps the job within 3 attempts. This is safe because there is only one worker.
9. **Worker loop.** While not stopping, claim a job:
   ```sql
   UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
   WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1)
   RETURNING *
   ```
   If nothing is claimed, `await sleep(200)`. Otherwise process the job:
   - **Failing attempt** (`attempts <= fail_attempts`): sleep 100 ms, leave progress at 0. If `attempts < 3`, set `status='queued'` and `run_after = Date.now() + 500`. Otherwise set `status='failed'`, `error='transient failure'`, `result_output=NULL`.
   - **Normal attempt:** for each step i = 1..steps, sleep 100 ms, then `UPDATE progress_completed=i, updated_at`. At the end set `status='completed'`, `result_output = input.toUpperCase()`, `progress_completed = steps`.
   - Every update sets `updated_at`.
10. **Worker SIGTERM.** Set `stopping=true`. If a job is in progress, stop after the current step and put it back in the queue (`status='queued', attempts=attempts-1, progress_completed=0`). Then `clearInterval`, `db.close()`, `process.exit(0)`. Exit must happen well within 5 s.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing `<input type="text" data-testid="job-input">`, `<input type="number" data-testid="job-steps" value="5">`, `<input type="number" data-testid="job-fail-attempts" value="0">`, and `<button type="submit" data-testid="job-submit">`. Do **not** use `required`, `min`, or `max` attributes, so that invalid values reach the API.
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list"></ul>`.
    - **Submit:** `preventDefault`. Build the body as `{input: rawValue}`. For each numeric field, trim the value: if empty, leave it out; if `Number(v)` is finite, send the number; otherwise send the raw string so the API rejects it.
    - **Response:** POST with `Content-Type: application/json`. If the response is not ok, set the error region's text to `error.message` plus one line per field (`field: message`). If ok, clear the error region and the input, then refresh the list.
    - **Rendering:** `refresh()` fetches `/api/jobs` and rebuilds the `<li data-testid="job-item" data-job-id=id>` elements, each with spans `job-status`, `job-progress` (`${completed}/${total}`), and `job-result` (output if completed, error if failed, otherwise empty), plus the input text. Use `textContent` only, never innerHTML with user data. Run it once at load, then `setInterval(refresh, 1000)`.

## Behaviours to verify
- **Build and checks:** `npm run build && npm run check:smoke && npm run check:contract` all pass.
- **Health:** with the worker running, `curl localhost:3000/health` reports `worker:"up"`. Within 3 s of killing the worker it reports `"down"`.
- **Validation:** curl these and expect 400 with the named field in `fields`, and no job created:
  - `{"input":"a","steps":"3"}` → `steps`
  - `{"input":"   "}` → `input`
  - `[1]` → `body`
  - malformed JSON → `body`
  - no Content-Type, or `text/plain` → `body`
  - `{"input":"a","steps":2.5}` → `steps`
  - header `Idempotency-Key: bad key!` → `Idempotency-Key`
- **Idempotency:** POST `{"input":"a"}` with key `k`, then `{"input":"a","steps":5,"failAttempts":0}` with key `k` → 200, same id. `{"input":"b"}` with key `k` → 409. Restart the server and replay → still 200 with the same id.
- **Retries:** `failAttempts:2` ends `completed` with `attempts:3`. `failAttempts:3` ends `failed`, `error:"transient failure"`, `attempts:3`, `result:null`. Poll in between and confirm the status goes back to `queued`.
- **Progress:** submit `steps:20` and poll `GET /api/jobs/:id` every 200 ms. `progress.completed` should rise gradually.
- **Crash recovery:** submit `steps:20`, `kill -9` the worker mid-run, restart it. The job should complete with `attempts:1` (the counter is decremented on recovery and incremented again on the re-run). Completed jobs stay untouched.
- **Shutdown:** `kill -TERM` each process. It should exit 0 within about 1 s.
- **Routing:** `DELETE /api/jobs` → 405. `GET /nope` → 404 `not_found`.
- **UI:** open `/`, submit steps 50 → the error region names `steps`. Submit a valid job → the item appears at the top and its status and progress update without a reload.

## Risks
- **HTML validation blocks submission:** browser attributes like `min`/`max`/`required` stop the form from submitting, so the API error never shows. Use `novalidate` and leave those attributes off.
- **List order:** sorting by `created_at` breaks ties within the same millisecond. Order by `seq`.
- **Recovery overshoot:** re-running a recovered job without adjusting `attempts` can go past 3 attempts. Decrement `attempts` on recovery and on graceful requeue.
- **Heartbeat starvation:** the heartbeat must keep running during long jobs. Use `setInterval`. The step sleeps are async, so the timer gets to run.
- **node:sqlite quirks:** `undefined` bindings throw, so use `null`. `RETURNING` works with `.get()`. Ints come back as numbers, which is fine.
- **Shutdown hangs:** keep-alive connections can stop `server.close()` from finishing, so call `closeAllConnections()`. Make sure SIGTERM handlers actually call `process.exit`.
- **Startup race:** both processes run `CREATE TABLE IF NOT EXISTS` at the same moment. Keep busy_timeout set before the WAL switch, as it is now.
- **UI path:** `dist/server.js` resolves `../ui/index.html` to the repo's `ui/`. Keep that URL-relative read, and don't move the UI file under `src/`.
- **Numeric types:** a JSON string `"3"` must be rejected. Use `typeof === 'number'`, never `Number(...)` coercion, on the server.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
