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
Both processes share one SQLite schema module (`src/db.ts`). The server is a single `node:http` handler that routes, validates and does idempotent inserts inside a `BEGIN IMMEDIATE` transaction. The worker is a polling loop: every ~200 ms it claims the oldest due queued job, runs the steps with `await sleep(100)`, writes progress after each step, and handles retries by setting the job back to `queued` with a `run_after` timestamp. A separate interval writes a heartbeat row every second, and `/health` reads it. When the worker starts, any job still marked `running` came from a dead worker (there is only one worker), so it is re-queued. The UI is one static HTML file with inline JS that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). Add `CREATE TABLE IF NOT EXISTS` for `jobs` and `heartbeat`, plus shared helpers: `rowToJob(row)`, `nowIso()`.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotency, the health check and SIGTERM handling.
- `src/worker.ts`: rewrite with recovery, the poll/claim loop, step processing, retries, the heartbeat and SIGTERM handling.
- `ui/index.html`: the form, the job list and the polling script, using the required `data-testid`s.

## Steps
1. **Schema** in `db.ts`, run on open by both processes. Each statement is idempotent.
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload_json TEXT)`
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL)`
   - Index on `(status, run_after, seq)`.
   - `rowToJob` builds the exact JSON shape: `progress: {completed, total: steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`.
   - Keep the `./db.ts` import style. `rewriteRelativeImportExtensions` is on.
2. **Server helper:** `send(res, status, body)` always sends `application/json; charset=utf-8`. Add `sendError(res, status, code, message, fields?)`.
3. **Routing** (path checked first, then method):
   - `/` (GET → HTML)
   - `/health` (GET)
   - `/api/jobs` (GET, POST)
   - `/api/jobs/<id>` (GET; `decodeURIComponent` inside a try, and a bad encoding returns 404)

   A known path with any other method returns `405 method_not_allowed`. Anything else returns `404 not_found`. Wrap the handler in try/catch so an exception returns `500 internal_error` as JSON.
4. **`/health`:** read `beat_at`. Return `worker: Date.now() - beat_at < 3000 ? 'up' : 'down'`. A missing row means down.
5. **POST validation.** Collect every error into `fields`, then return 400 if there are any.
   - `Content-Type` must exist and match `/^application\/json\b/i` (charset allowed). Otherwise add field `body`. Still read and drain the request body.
   - `Idempotency-Key` header: if present (even empty), it must match `^[A-Za-z0-9_-]{1,128}$`. Otherwise add field `Idempotency-Key`.
   - Read the body as a utf8 string with a cap of about 1 MB. Larger bodies get a `body` error.
   - If `JSON.parse` throws, add a `body` error. If the result is not a plain object (null, array or primitive), add a `body` error.
   - For an object, report each unknown key under its own name.
   - `input`: must be `typeof 'string'`, `1 ≤ length ≤ 1000` and `input.trim().length > 0`. Store it exactly as sent.
   - `steps` / `failAttempts`: if present, they must satisfy `typeof v === 'number' && Number.isInteger(v)` and fall in range. `"3"` is rejected. Apply defaults 5 and 0.
6. **Create / idempotency.** Run `BEGIN IMMEDIATE` … `COMMIT`, with `ROLLBACK` on error. Use canonical `payload = JSON.stringify({input, steps, failAttempts})` with a fixed key order.
   - If a key was sent, `SELECT` by `idempotency_key`.
     - Found, same `payload_json` → `200` with that job.
     - Found, different payload → `409 idempotency_conflict`.
   - Otherwise `INSERT` with `id = crypto.randomUUID()`, status `queued`, attempts 0, `run_after = 0`, and identical ISO timestamps → `201`.
   - Without a key, store `idempotency_key` as NULL, so SQLite UNIQUE allows many rows.
7. **`GET /api/jobs`:** `ORDER BY seq DESC`, so newest first is stable even when timestamps tie. `GET /api/jobs/:id`: return 404 `not_found` if it is missing.
8. **Server shutdown:** on SIGTERM or SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()`, then `process.exit(0)`. Add a 2 s fallback exit timer and `unref()` it.
9. **Worker startup:**
   - `openDatabase()`.
   - Recovery: `UPDATE jobs SET status='queued', progress_completed=0, run_after=0, updated_at=? WHERE status='running'`.
   - Write a heartbeat immediately with `INSERT … ON CONFLICT(id) DO UPDATE`, then repeat it every 1000 ms with `setInterval`. The step loop is async, so heartbeats keep going during processing.
10. **Worker loop:** while not stopping:
    - `SELECT * FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY seq LIMIT 1`.
    - If none, sleep 200 ms.
    - Claim it with `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`. Check `changes === 1`, then re-read the row.
11. **Processing an attempt** (`n = attempts`):
    - **If `n ≤ failAttempts`:** fail now, before any progress (an optional 100 ms sleep first is fine).
      - If `n < 3`: `status='queued', run_after=Date.now()+500`, progress stays 0, error stays NULL.
      - Otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - **Otherwise,** for i = 1..steps:
      - `await sleep(100)`.
      - If stopping, return and leave the job `running`. Recovery re-runs it on the next start.
      - `UPDATE progress_completed=i, updated_at`.
    - **After the last step:** `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Every status UPDATE also sets `updated_at`.
12. **Worker shutdown:** on SIGTERM or SIGINT, set `stopping`. The loop exits within about 100 ms. Clear the interval, optionally delete the heartbeat row, call `db.close()` and `process.exit(0)`. Add a 2 s fallback exit timer and `unref()` it.
13. **UI form** (`ui/index.html`): `<form data-testid="job-form" novalidate>` containing:
    - `<input data-testid="job-input" type="text">` with no `required`/`maxlength`, so the API does the validation
    - `<input data-testid="job-steps" type="number" value="5">` and `<input data-testid="job-fail-attempts" type="number" value="0">` with no min/max
    - `<button data-testid="job-submit" type="submit">`
    - `<div data-testid="form-error" role="alert"></div>`
    - `<ul data-testid="job-list">`
14. **UI submit:** call `preventDefault`. For each numeric field: if it is empty, omit it. Otherwise use `Number(v)`, and if that gives NaN, send the raw string so the API rejects it. POST with `Content-Type: application/json`.
    - On a non-2xx response, set `form-error` textContent to `error.message` plus one line per field: `"<field>: <message>"`.
    - On success, clear `form-error` and refresh right away.
15. **UI list:** poll every 1000 ms. Keep a `Map<id, li>` and update elements in place rather than rebuilding, so evaluator element handles stay valid. Order children newest first, following the API order.
    - Each `<li data-testid="job-item" data-job-id>` contains spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, otherwise empty).
    - Use `textContent` only, never innerHTML with user data.

## Behaviours to verify
- **Build and start:** run `npm run build && PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server` and start the worker in another shell with the same env. Start them in both orders. The dir `/tmp/jt` must get created.
- **Health:** `curl localhost:3100/health` shows `"worker":"up"` while the worker runs, and `down` about 3 s after killing it.
- **Create:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}'` → 201, queued, attempts 0, progress `0/2`.
- **Validation:** each of these gives 400 with the right `fields` entry:
  - `steps:"2"`, `failAttempts:7`, `colour:"blue"`, missing `input`, `"   "` input, a 1001-char input
  - body `[]`, body `nul`, no content-type, `text/plain`
  - `Idempotency-Key: bad key!`

  The job count must not change.
- **Idempotency:** the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` → 201 then 200 with the same id. A changed input → 409. Restart the server and replay → 200.
- **Processing:** poll `GET /api/jobs/:id` during a 20-step job and watch `progress.completed` rise. The final state is completed, `output` is uppercase, and progress is `20/20`.
- **Retries:** `failAttempts:1` → completed, attempts 2. `failAttempts:2` → attempts 3, completed. `failAttempts:3` → failed, `"transient failure"`, attempts 3, result null. In every case only one job exists in the list.
- **Crash recovery:** start a 20-step job, `kill -9` the worker mid-run, and restart it. The job completes. Completed jobs keep their `updated_at` unchanged.
- **Routing:** `DELETE /api/jobs` → 405, `GET /nope` → 404, `GET /api/jobs/zzz` → 404 `not_found`. All are JSON.
- **SIGTERM:** both processes exit with code 0 quickly.
- **Repo checks:** run `npm run check:smoke` and `npm run check:contract`.
- **UI:** open `/` in a browser. Submit `steps` 25 and check that `form-error` names `steps`. Submit a valid job and check that status and progress update without a reload.

## Risks
- **Lock contention:** without `busy_timeout` and short transactions you get SQLITE_BUSY. Keep the existing pragmas, and never hold a transaction across an `await`.
- **Ordering:** don't sort by `created_at` alone, because millisecond ties give the wrong order. Use `seq`.
- **Type coercion:** `Number.isInteger("3")` is false, but don't coerce first. Also check `typeof`.
- **Content-Type with a charset** (e.g. `application/json; charset=utf-8`) must be accepted.
- **Unknown fields:** don't stop at the first error. The checker looks for the specific field name (e.g. `colour`).
- **Idempotency races:** do the lookup and insert inside one `BEGIN IMMEDIATE` transaction. The UNIQUE constraint is a backstop: if the insert hits a constraint error, re-select and respond.
- **Crash-recovered attempts:** a job recovered after a crash gets one more attempt, and `attempts` counts it honestly. Failure is still decided by `n ≤ failAttempts`, and the job becomes `failed` once a failed attempt has `n ≥ 3`.
- **Heartbeat gaps:** the heartbeat must not be blocked by job processing. Use `setInterval` and async sleeps, never busy-waits.
- **Browser validation in the UI:** `required`, `min`, `max` or `maxlength` attributes would stop invalid values reaching the API, and the evaluator expects API errors in `form-error`. Use `novalidate` and no constraints.
- **Hanging on shutdown:** open intervals or keep-alive sockets can stop a process from exiting. Clear them and call `process.exit(0)` explicitly.
- **Paths:** the HTML is read via `new URL('../ui/index.html', import.meta.url)` relative to `dist/`, which works because `ui/` sits beside `dist/`. Keep that path.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
