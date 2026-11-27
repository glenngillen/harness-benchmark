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
Keep the existing layout: `src/db.ts` (opens the database and creates the schema), `src/server.ts` (HTTP API plus the UI), `src/worker.ts` (polling worker) and `ui/index.html` (a single page with inline JS). Both processes share one SQLite database in WAL mode. They communicate only through two tables: `jobs`, and `worker_heartbeat`, which the worker writes every 1 s and `/health` reads. The worker claims jobs inside `BEGIN IMMEDIATE` transactions. A `run_after` timestamp handles retry delays. When the worker starts, it puts any `running` jobs back in the queue so they recover after a crash. Idempotency relies on a UNIQUE `idempotency_key` column plus a stored canonical payload, so it still holds after a restart.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for both tables, a `rowToJob(row)` serializer, and shared types and constants (`MAX_ATTEMPTS = 3`).
- `src/server.ts`: rewrite with routing, validation, idempotency, JSON errors, health and SIGTERM handling.
- `src/worker.ts`: rewrite with the heartbeat, startup recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: the form, error region, job list and polling script, with all the required `data-testid`s.

## Steps
1. **Schema** (in `db.ts`, run by both processes; it is idempotent):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
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
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,  -- epoch ms
     idempotency_key TEXT UNIQUE,
     payload TEXT                            -- canonical JSON
   );
   CREATE TABLE IF NOT EXISTS worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
   ```
   - Put the `CREATE`s inside the same `exec` after the pragmas.
   - `rowToJob` returns the exact JSON shape:
     - `result`: `{output}` when `status === 'completed'`, else `null`.
     - `error`: the error text when `status === 'failed'`, else `null`.
     - `progress`: `{completed: progress_completed, total: steps}`.
   - Timestamps come from `new Date().toISOString()`.
2. **Server helpers:**
   - `send(res, status, body)` always sets `application/json`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body as a Buffer with a cap of about 1 MB (over the cap → 400 `body`). Decode it as utf8.
3. **Routing** (match `pathname` exactly):
   - `/` → GET serves the HTML. Any other method → 405.
   - `/health` → GET. Other methods → 405.
   - `/api/jobs` → GET lists jobs, POST creates one. Other methods → 405.
   - `/api/jobs/<id>` (regex `^/api/jobs/([^/]+)$`, decode the id) → GET. Other methods → 405. Unknown id → 404 `not_found`.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch → 500 `internal_error`.
4. **Validation (POST)**, collecting `fields[]`:
   - Content-Type: `(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json'`, else field `body`.
   - `Idempotency-Key`: if the header is present (even empty), it must match `/^[A-Za-z0-9_-]{1,128}$/`, else field `Idempotency-Key`.
   - Body: parse JSON (failure → `body`). It must be a plain object: not null, not an array.
   - Every key other than `input`, `steps`, `failAttempts` → an error on that key's name.
   - `input`: must be a string with `1 <= length <= 1000` and `input.trim() !== ''`.
   - `steps` and `failAttempts`, if present (`!== undefined`): `typeof === 'number' && Number.isInteger(v)` and within range.
   - If there are any errors → 400 `invalid_request` listing all of them. Check the Content-Type and the key together, and skip body checks if the Content-Type is bad.
5. **Create**:
   - Build `payload = JSON.stringify({input, steps, failAttempts})` with defaults applied, in a fixed key order.
   - In `BEGIN IMMEDIATE`: if a key was sent, `SELECT` by `idempotency_key`. If found: same payload → COMMIT, 200 with that job. Different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = crypto.randomUUID()`, `status='queued'`, `run_after=0`. COMMIT, then 201.
   - ROLLBACK on exceptions.
6. **List and health:**
   - List: `SELECT * FROM jobs ORDER BY seq DESC`. Use `seq`, not `created_at`, because timestamps can tie.
   - Health: `worker = (Date.now() - last_seen) < 3000 ? 'up' : 'down'`. A missing row means `down`.
7. **Server shutdown:** on SIGTERM/SIGINT, `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`.
8. **Worker startup:**
   - Upsert the heartbeat immediately: `INSERT ... ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`. Then repeat it every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', run_after=0, progress_completed=0, updated_at=? WHERE status='running'`.
9. **Worker loop** (`while (!stopping)`):
   - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq ASC LIMIT 1`.
   - Then `UPDATE ... SET status='running', attempts=MIN(attempts+1,3), progress_completed=0, updated_at=? WHERE id=? AND status='queued'`, and COMMIT.
   - The `MIN` cap means a crash during attempt 3 re-runs it as attempt 3. This is safe: a crash after step 1 means `failAttempts < 3`.
   - If nothing was claimed, sleep 200 ms.
10. **Process a claimed job** (`n` = the new attempts value):
    - If `n <= fail_attempts`, the attempt fails at the first step, with no progress:
      - `n < 3` → `status='queued'`, `run_after=now+500`, `progress_completed=0`.
      - Otherwise → `status='failed'`, `error='transient failure'`, `result_output=NULL`.
    - Otherwise, for each step `i` in `1..steps`: `await sleep(100)`. If `stopping`, break. Then `UPDATE progress_completed=i, updated_at`.
    - At the end: `status='completed'`, `result_output=input.toUpperCase()`, `progress_completed=steps`.
    - Every terminal or requeue UPDATE must include `WHERE id=? AND status='running'`.
11. **Worker SIGTERM:**
    - Set `stopping`. The current step loop breaks, and the in-flight job is requeued (`status='queued'`, `progress_completed=0`, `run_after=0`).
    - Clear the interval, delete the heartbeat row (optional), `db.close()`, and exit 0 within about 200 ms.
12. **UI (`ui/index.html`):**
    - `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - `<div data-testid="form-error" role="alert"></div>`
    - `<ul data-testid="job-list"></ul>`
    - On submit (`preventDefault`):
      - Numeric fields: an empty string → omit the field. A finite `Number(v)` → send the number. Otherwise send the raw string so the API rejects it.
      - POST with `Content-Type: application/json`.
      - Not ok → put `error.message` plus each `fields[i].field + ': ' + message` in form-error. Ok → clear form-error and refresh right away.
    - Polling: `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>`, containing:
      - `<span data-testid="job-status">`
      - `<span data-testid="job-progress">completed/total</span>`
      - `<span data-testid="job-result">`: the output if completed, the error if failed, else `''`.
    - Use `textContent` only, never innerHTML with user data.

## Behaviours to verify
- **Build and start:** `npm run build && DATABASE_PATH=/tmp/t/x.db PORT=3100 npm run start:server` in one shell and `start:worker` in another (try both start orders). Then `curl :3100/health` should show `worker:"up"`. Kill the worker; within 3 s it should show `"down"`.
- **Checks:** `npm run check:smoke` and `npm run check:contract` pass.
- **Validation:** each of these returns 400 with the right `fields` entry: `{"input":"a","steps":"3"}`; `steps: 2.5`, `0`, `21`; `failAttempts: 6`; `{"input":"   "}`; an extra key `x`; `[]`; `"str"`; malformed JSON; `text/plain` Content-Type; a missing Content-Type; key `bad key!`.
- **Idempotency:** POST twice with the same key and `{"input":"a"}`, then `{"input":"a","steps":5,"failAttempts":0}` → 201, 200, 200 with the same id. Change the input → 409. Restart the server and replay → still 200 with the same id.
- **Progress:** with `steps: 10`, poll `GET /api/jobs/:id` every 100 ms and watch `progress.completed` go up. The final `result.output` is uppercase (also try `"straße"` → `"STRASSE"`).
- **Retries:** `failAttempts: 2` → completed with `attempts: 3`. `failAttempts: 3` → failed, `error: "transient failure"`, `attempts: 3`, `result: null`.
- **Crash recovery:** start a `steps: 20` job, `kill -9` the worker mid-run, restart it → the job completes. Completed jobs keep their `updatedAt` unchanged.
- **Routes:** `DELETE /api/jobs` → 405; `GET /nope` → 404 `not_found`; `GET /api/jobs/unknown` → 404.
- **UI:** open `/`, submit `steps` 25 → form-error mentions `steps`. A valid submission shows up and progresses without a reload.

## Risks
- **`SQLITE_BUSY` between the two processes:** keep the busy_timeout. Use `BEGIN IMMEDIATE` for read-then-write transactions, and always ROLLBACK in `finally` on error.
- **Booleans or numeric strings passing integer checks:** require `typeof v === 'number'`.
- **Duplicate jobs from concurrent same-key requests:** the check and insert run in one IMMEDIATE transaction, and the UNIQUE constraint backs it up. If the insert hits a UNIQUE error anyway, re-select and replay.
- **Attempts exceeding 3 after crash recovery:** use the `MIN(attempts+1, 3)` cap.
- **Reprocessing finished jobs:** every UPDATE is guarded by `status='running'`, and recovery only touches `running` rows.
- **Wrong list order:** order by `seq`, not `created_at`.
- **Browser validation blocking the submission:** use `novalidate` and no `min`/`max`/`required` constraints, so the API's errors appear in the UI.
- **Import paths:** keep the `.ts` imports (`./db.ts`); `rewriteRelativeImportExtensions` handles them. Don't add `.js`.
- **The UI file path:** the server reads `../ui/index.html` relative to `dist/`. Keep the existing path logic.
- **Unhandled rejections in the worker loop:** wrap each iteration in try/catch, log, and continue.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
