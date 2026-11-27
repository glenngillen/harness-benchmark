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
Keep the current layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` is a `node:http` server, `src/worker.ts` is a polling loop, and `ui/index.html` is one static page with inline JS. All state lives in SQLite (WAL plus busy_timeout, already set up). That includes a `jobs` table with a scheduled `run_at` for retries, a UNIQUE idempotency-key column, and a `worker_heartbeat` row that the server reads for `/health`. The worker claims jobs inside `BEGIN IMMEDIATE` transactions and writes progress after every step. When it starts up, it requeues any job left `running`. Relative imports keep the `.ts` extension (e.g. `./db.ts`) because tsconfig uses `rewriteRelativeImportExtensions`.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` schema, a `Job` row→JSON mapper, `nowIso()` and a small `tx(db, fn)` helper (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`).
- `src/server.ts`: routing, validation, idempotency, health, static UI, SIGTERM handling.
- `src/worker.ts`: heartbeat, recovery, claim loop, step processing, retries, SIGTERM handling.
- `ui/index.html`: form, error region, job list, 1 s polling.
- Optional `src/validate.ts`: a pure validation function, if that keeps the server tidy.

## Steps
1. **Schema** (in `db.ts`, run by both processes on open; it is idempotent):
   `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INT, fail_attempts INT, attempts INT DEFAULT 0, progress INT DEFAULT 0, output TEXT NULL, error TEXT NULL, idem_key TEXT UNIQUE NULL, created_at TEXT, updated_at TEXT, run_at INTEGER NOT NULL /*epoch ms*/)`, plus an index on `(status, run_at, seq)`.
   `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER)`.
   Run the schema exec after the PRAGMAs.
2. **Mapper** `toJson(row)`: `{id, status, input, steps, failAttempts, attempts, progress:{completed, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`. Timestamps come from `new Date().toISOString()`.
3. **Server routing**: parse the pathname. Known paths are `/`, `/health`, `/api/jobs` and `/^\/api\/jobs\/([^/]+)$/`. A wrong method on any of these returns 405 `method_not_allowed`. Anything else returns 404 `not_found`. Every JSON response uses `application/json; charset=utf-8`. Wrap the handler in try/catch and return 500 `internal_error` on failure.
4. **`GET /health`**: read `beat_at`. Return `worker: 'up'` if `Date.now() - beat_at < 3000`, otherwise `'down'`.
5. **`GET /api/jobs`**: `ORDER BY seq DESC`. **`GET /api/jobs/:id`**: decode the id with `decodeURIComponent` inside a try block. Return 404 `not_found` if the job is missing.
6. **`POST /api/jobs` validation** (collect all field errors, return 400 `invalid_request` with a `fields` array):
   - Content-Type: take the media type before `;`, trim and lowercase it, and require `application/json`. Missing or other values → field `body`. Still read and discard the request body.
   - Idempotency-Key header: if present and it fails `^[A-Za-z0-9_-]{1,128}$` → field `Idempotency-Key`.
   - Read the whole body. `JSON.parse` failure (including an empty body) → `body`. Not a plain object (null, an array, a primitive) → `body`.
   - Unknown keys → one entry per key, named after the key.
   - `input`: must be `typeof 'string'`, have length 1–1000, and have `trim() !== ''`. Store it untrimmed.
   - `steps` / `failAttempts`: if present, must be `typeof 'number'`, `Number.isInteger`, and in range (1–20 / 0–5). Apply defaults 5 / 0.
7. **Create with idempotency**: use `tx` (BEGIN IMMEDIATE). If a key was sent, `SELECT` by `idem_key`. If a row exists and its `input`, `steps` and `fail_attempts` all equal the normalized payload, return 200 with that job. If they differ, return 409 `idempotency_conflict`. Otherwise `INSERT` with `id = randomUUID()`, `status='queued'`, `run_at=Date.now()`, and return 201. The UNIQUE constraint backs this up; if a constraint error occurs, re-run the lookup.
8. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Keep the existing `readFileSync` of `ui/index.html` (the path is relative to `dist/`, so `../ui/index.html` still resolves).
9. **Worker startup**:
   - Open the DB and write the heartbeat right away, then every 500 ms with `setInterval` (`INSERT ... ON CONFLICT(id) DO UPDATE`).
   - Recovery: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, run_at=now, updated_at=now WHERE status='running'`. The interrupted attempt is redone, not counted twice. This keeps `attempts ≤ 3` and keeps the failAttempts arithmetic correct. It is safe because there is a single worker.
10. **Worker loop**: repeat while not stopping.
    - Claim in `tx`: `SELECT ... WHERE status='queued' AND run_at<=? ORDER BY seq ASC LIMIT 1`, then `UPDATE SET status='running', attempts=attempts+1, progress=0, updated_at`. If nothing is claimed, sleep 200 ms.
    - For a claimed job with `n = attempts`: if `n <= fail_attempts`, the attempt fails immediately (before any progress). If `n >= 3`, set `status='failed', error='transient failure'`. Otherwise set `status='queued', run_at=now+500`.
    - Otherwise, for each step i = 1..steps: `await sleep(100)`. If stopping, break. Then `UPDATE progress=i, updated_at`.
    - After the last step: `status='completed', output=input.toUpperCase(), progress=steps`.
    - Every update after the claim includes `WHERE id=? AND status='running'`.
11. **Worker SIGTERM**: set `stopping`. If a job is mid-flight, requeue it the same way recovery does (`attempts-1`, progress 0, queued). Then clear the interval, close the DB and exit 0. A loop that checks `stopping` each step exits within about 100 ms.
12. **UI** (`ui/index.html`):
    - Use `<form data-testid="job-form" novalidate>` with no HTML `required`/`min`/`max` blocking, so the API's validation errors show up.
    - Fields: `job-input` (text), `job-steps` (`type=number`, value 5), `job-fail-attempts` (`type=number`, value 0), `job-submit`. Add `<div data-testid="form-error" role="alert"></div>`.
    - On submit, `preventDefault`. Build the body: `input` as a string. For each numeric field, if the value is empty, omit it. If `Number(v)` is finite, send the number. Otherwise send the raw string so the API rejects it.
    - POST as JSON. If the response is not OK, set form-error text to the message plus each `field: message`. If it is OK, clear form-error and refresh.
    - Poll `GET /api/jobs` every 1000 ms. Render `<ul data-testid="job-list">` with `<li data-testid="job-item" data-job-id>` that contains `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (output if completed, error if failed, else empty). Set values with `textContent` (no innerHTML of user input) and only re-render the list, never the form.

## Behaviours to verify
- Build and start: `npm run build`, then `npm run start:server` and `npm run start:worker` in either order. Check `curl localhost:3000/health` shows `worker` `up`, and `down` about 3 s after killing the worker.
- Contract checks: `npm run check:smoke` and `npm run check:contract` must pass.
- Validation: POST with `steps:"2"`, `failAttempts:7`, an extra `colour`, a missing `input`, `"   "` as input, `[]`, malformed JSON, `text/plain` Content-Type, and a bad Idempotency-Key. Each returns 400 with the right `fields[].field`, and the job count does not change.
- Idempotency: the same key with `{input:"a"}` and then `{input:"a",steps:5,failAttempts:0}` returns 201, then 200 with the same id. A different input returns 409. Restart the server and replay: still 200.
- Progress: a `steps:10` job shows `progress.completed` rising when you poll `GET /api/jobs/:id`.
- Retries: `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with attempts 3, error `"transient failure"` and result null. Exactly one job exists per submission.
- Crash recovery: start a `steps:20` job, `kill -9` the worker mid-run and restart it. The job completes within about 10 s plus its run time, with attempts ≤ 3. Completed jobs are never touched again (`updatedAt` stays the same).
- SIGTERM: both processes exit quickly with code 0.
- UI: open `/`, submit an empty input and see `input` in form-error. Submit a valid job and watch status and progress update without a reload.

## Risks
- **Importing without `.ts`**: imports must stay `./db.ts`, or the build/runtime resolution breaks. Do not edit tsconfig.
- **SQLITE_BUSY between processes**: use `BEGIN IMMEDIATE` for read-then-write sequences and keep transactions short. Never hold a transaction across an `await`.
- **Double-counting attempts after a crash**: decrement on recovery, as described above.
- **Browser validation hiding API errors**: use `novalidate` and avoid `required`/`min`/`max`.
- **Content-Type with charset** (`application/json; charset=utf-8`) must be accepted. Check that `typeof x === 'number'` rejects booleans and numeric strings.
- **Responses must be JSON**: 404/405 must also be JSON. Only `GET /` returns HTML.
- **Slow shutdown**: the heartbeat interval or open HTTP keep-alive connections can keep a process alive. Clear the interval and call `closeAllConnections`, then `process.exit(0)`.
- **Retry delay**: it must be at least 250 ms and below 2 s. Use 500 ms, and keep the idle poll at 200 ms or less so new jobs start within 1 s.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
