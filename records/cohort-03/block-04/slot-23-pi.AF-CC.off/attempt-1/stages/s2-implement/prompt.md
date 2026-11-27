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
There are three source modules. `src/db.ts` holds the schema, the row-to-JSON mapper and shared helpers. `src/server.ts` handles routing, validation and idempotency using `node:http`. `src/worker.ts` runs a loop that claims and processes jobs. The two processes share state only through SQLite tables: `jobs`, plus a one-row `heartbeat` table. Every write that has to be atomic (claiming a job, inserting with an idempotency key) runs inside `BEGIN IMMEDIATE … COMMIT`, using the existing `busy_timeout` and WAL setup. `ui/index.html` is one static page with inline JS. It polls `GET /api/jobs` every second and updates the job list in place.

## Files
- `src/db.ts`: keep `openDatabase`. After opening, run idempotent `CREATE TABLE IF NOT EXISTS` statements. Export `JobRow` type, `toJob(row)`, `nowIso()`, and a `tx(db, fn)` helper (BEGIN IMMEDIATE / COMMIT / ROLLBACK on throw).
- `src/server.ts`: rewrite. Include the router, body reader, validation, idempotency, health check, UI serving and SIGTERM shutdown.
- `src/worker.ts`: rewrite. Include the heartbeat, crash recovery, claim loop, step processing, retries and SIGTERM shutdown.
- `ui/index.html`: build the form and list with all the required `data-testid`s and the polling script.
- Do not touch package.json, tsconfig, checks/, .gitignore or TASK.md. Keep the `./db.ts` import style, since tsconfig rewrites the extensions. `dist/server.js` reads `../ui/index.html`, so leave the `ui/` location as it is.

## Steps
1. **Schema** in db.ts:
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT, run_at INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL);
   ```
   `toJob` returns exactly the specified shape: `result` is `{output}` only when the status is completed, otherwise null. `error` comes from the column and is null unless the job failed. `progress` is `{completed: progress_completed, total: steps}`.
2. **Server helpers:** `send(res,status,body)` always sends `application/json; charset=utf-8`. `sendError(res,status,code,message,fields?)`.
3. **Routing** (pathname from `new URL`):
   - `/` → GET only (HTML).
   - `/health` → GET.
   - `/api/jobs` → GET, POST.
   - `/api/jobs/:id`, matched by `^/api/jobs/([^/]+)$` → GET. A missing id gives 404 `not_found`.
   - A known path with any other method → 405 `method_not_allowed`, with an `Allow` header.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **Health:** `SELECT beat_at FROM heartbeat WHERE id=1`. Return `worker: "up"` if `Date.now() - beat_at < 3000`, else `"down"`. Treat a missing row as down.
5. **POST validation.** Read the whole body as a utf8 string first, so the request is drained. Then build a `fields` array:
   - Content-Type: take the media type before `;`, trim and lowercase it. If it is missing or not `application/json`, add `{field:"body"}`.
   - Idempotency-Key: if the header is present (`req.headers['idempotency-key'] !== undefined`) and fails `^[A-Za-z0-9_-]{1,128}$`, add `{field:"Idempotency-Key"}`. An empty string counts as invalid.
   - If the content type is OK, `JSON.parse` inside try/catch. Malformed JSON → `body`. `null`, an array or a primitive → `body`.
   - For an object, add each key not in {input, steps, failAttempts} as its own field entry.
   - `input`: must be `typeof 'string'`, with length from 1 to 1000, and `input.trim() !== ''`.
   - `steps` / `failAttempts`: if present (not `undefined`), they must be `typeof 'number'`, `Number.isInteger`, and in range (1–20 and 0–5). Strings like `"3"` and `null` are rejected.
   - If `fields` has any entries → 400 `invalid_request` with message "Invalid request" and the `fields` list.
6. **Create the job.** Normalise to `{input, steps: steps??5, failAttempts: failAttempts??0}`. Compute `payload = JSON.stringify([input, steps, failAttempts])`, which gives a fixed order. Then, inside `tx`:
   - If there is a key, `SELECT * FROM jobs WHERE idempotency_key=?`. If a row exists: same payload → 200 with `toJob(row)`; different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = crypto.randomUUID()`, status `queued`, `run_at = 0`, `created_at = updated_at = nowIso()`, then 201.
   - The UNIQUE constraint plus BEGIN IMMEDIATE ensures a key creates at most one job, even across restarts.
7. **Read endpoints:** `GET /api/jobs` → `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. `GET /api/jobs/:id` → the job or 404.
8. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a fallback timer of about 2 s that also exits.
9. **Worker startup:**
   - Open the db (the schema is created by `openDatabase`) and write the heartbeat immediately: `INSERT … ON CONFLICT(id) DO UPDATE SET beat_at=?`.
   - Repeat the heartbeat with `setInterval` every 1000 ms. Because processing is async (await sleep), the interval keeps firing while a job runs.
   - **Recovery:** `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_at=0, updated_at=? WHERE status='running'`. The interrupted attempt is re-run as the same attempt number, so `attempts` never goes past 3 and the failAttempts rule stays deterministic. Only one worker runs at a time, so this is safe.
10. **Worker loop** (`while (!stopping)`):
    - Claim inside `tx`: `SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY seq ASC LIMIT 1`. If a row is found, `UPDATE … SET status='running', attempts=attempts+1, progress_completed=0, error=NULL, updated_at=? WHERE id=? AND status='queued'`.
    - If nothing was claimed, `await sleep(200)` and loop again.
    - **Process attempt n:**
      - For `i` from 1 to steps: `await sleep(100)`. If `stopping`, abort (see step 11). When `i===1 && n <= fail_attempts`, the attempt fails before any progress is written. Otherwise `UPDATE progress_completed=i, updated_at`.
      - On success: `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
      - On failure with `n < 3`: `status='queued', run_at=Date.now()+500, progress_completed=0`.
      - On failure with `n >= 3`: `status='failed', error='transient failure', result_output=NULL`.
      - Every update also sets `updated_at`.
11. **Worker shutdown:** on SIGTERM/SIGINT set `stopping=true`. If a job is mid-attempt, put it back to `queued` with `attempts-1` (same as recovery), then clear the interval. Set `beat_at=0` so health reports down quickly, then `db.close()` and `process.exit(0)`. Make sure this runs within about 1 s.
12. **UI (`ui/index.html`):**
    - Form `data-testid="job-form"` with `novalidate`. Inputs:
      - `job-input`: a text field, not `required`.
      - `job-steps`: `type="number"`, default value 5.
      - `job-fail-attempts`: `type="number"`, default value 0.
    - Button `job-submit` (type submit).
    - `<div data-testid="form-error" role="alert"></div>`.
    - `<ul data-testid="job-list">`.
    - **On submit:** call `preventDefault`. Build the body as `{input: value}`. For each numeric field: an empty value is omitted; otherwise send `Number(v)` if it is finite, else the raw string.
    - POST with `Content-Type: application/json`.
    - If the response is not ok: put `error.message` plus one line per field (`"<field>: <message>"`) into `form-error` using textContent.
    - If ok: clear `form-error`, reset the input text, and refresh at once.
    - **Polling:** `setInterval(refresh, 1000)`, plus one refresh on load.
    - **Rendering:** keep a `Map` from id to `<li data-testid="job-item" data-job-id>`. Each item contains spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (the output when completed, the error when failed, else ''), plus the input text. Re-append items in API order (newest first). Use textContent only.

## Behaviours to verify
- Build and start: `npm run build && PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server` and `start:worker` in another shell, starting them in both orders. `/tmp/jt` should be created.
- Health: `curl :3100/health` shows `up` while the worker runs. After killing the worker, it shows `down` within 3 s.
- Create and progress: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hello","steps":5}'` → 201 queued. Polling GET by id should show progress 1..5, then `completed`, `result.output="HELLO"`.
- Retries: `failAttempts:2` → completed with attempts 3. `failAttempts:3` → failed, `error:"transient failure"`, attempts 3, result null.
- Validation: each of these gives 400 with the right `fields` entries: `{"input":"a","x":1}` → `x`; `{"input":"a","steps":"3"}` → `steps`; `steps:0`, `steps:2.5`, `failAttempts:6`; `{"input":"   "}`; `[]`; `nope`; text/plain content type; `Idempotency-Key: bad key!`. Afterwards, `GET /api/jobs` should show no new jobs.
- Idempotency: send key `k1` with `{"input":"a"}` (201), then `{"input":"a","steps":5,"failAttempts":0}` (200, same id), then `{"input":"b"}` (409). Restart the server and repeat → still 200 with the same id.
- Routing: `/nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `GET /api/jobs/unknown` → 404.
- Crash recovery: start a job with `steps:20`, `kill -9` the worker mid-run, restart it → the job completes. All jobs are still listed after both processes are SIGKILLed and restarted. Completed jobs keep the same `updatedAt`.
- SIGTERM: both processes exit with code 0 quickly.
- `npm run check:smoke` and `npm run check:contract` pass.
- UI: open `/`. Submit steps=0 and form-error should show "steps". Submit a valid job and it should appear at the top, with progress updating live.

## Risks
- **Native browser validation blocks the submission** and the API error never shows. Use `novalidate`, no `required`, no `min`/`max`.
- **The heartbeat stalls during processing** if the worker uses synchronous busy-waits. Always use `await sleep`.
- **SQLITE_BUSY between processes:** keep transactions short, use BEGIN IMMEDIATE for any read-then-write, and never hold a transaction across an `await`.
- **The body is not drained** before replying 400 for a bad content-type or key, which can reset connections. Always read the full body first.
- **`node:sqlite` rows have a null prototype,** and integers come back as numbers. Always map through `toJob`, and never return raw rows.
- **Out-of-order JSON keys break the idempotency comparison.** Compare the normalised tuple, not the raw body.
- **Recovery double-counts attempts** and pushes `attempts` past 3. Use the decrement described in steps 9 and 11.
- **Ordering:** `createdAt` can tie, so use `seq` for both newest-first and oldest-first.
- **`numericString` checks:** use `typeof === 'number'`, not `Number(x)`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
