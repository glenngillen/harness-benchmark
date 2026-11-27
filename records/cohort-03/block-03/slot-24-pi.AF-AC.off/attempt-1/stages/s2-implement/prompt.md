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
Keep the existing three-file layout: `src/db.ts` holds the schema and shared helpers, `src/server.ts` is the HTTP API and serves the UI, and `src/worker.ts` is the polling worker. Use only `node:sqlite` `DatabaseSync` in WAL mode with the existing busy_timeout. All multi-statement read-then-write logic runs inside `BEGIN IMMEDIATE … COMMIT`, so the two processes can never race. Never hold a transaction open across an `await`. The worker claims jobs atomically, writes progress after each step, schedules retries with a `run_after` timestamp column, and writes a heartbeat row every 500 ms. `ui/index.html` is a self-contained vanilla-JS page that polls `GET /api/jobs` every second.

## Files
- `src/db.ts`: keep `openDatabase`. Add `CREATE TABLE IF NOT EXISTS` for `jobs` and `heartbeat`, plus `rowToJob(row)` (DB row → API JSON shape) and a `tx(db, fn)` helper (BEGIN IMMEDIATE / COMMIT / ROLLBACK on throw).
- `src/server.ts`: rewrite. Routing, body reading, validation, idempotency, health, UI, and SIGTERM handling.
- `src/worker.ts`: rewrite. Heartbeat, crash recovery, claim loop, step processing, retries, and SIGTERM handling.
- `ui/index.html`: form, error region, job list, and inline script.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
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
     payload TEXT NOT NULL                  -- canonical JSON
   );
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL);
   ```
   - Both processes run this, which is safe because of `IF NOT EXISTS` and busy_timeout.
   - `rowToJob` returns exactly: `id, status, input, steps, failAttempts, attempts, progress:{completed,total:steps}, result: result_output!=null && status==='completed' ? {output} : null, error, createdAt, updatedAt`.
   - Generate IDs with `crypto.randomUUID()` and timestamps with `new Date().toISOString()`.
2. **Server helpers:**
   - `send(res, status, body)` as it is now.
   - `sendError(res, status, code, message, fields?)`.
   - `readBody(req)` collects chunks into a utf8 string. Cap it at about 1 MB; past that, respond `400 invalid_request` with field `body`.
3. **Routing** (on `pathname`):
   - `/health` → GET only.
   - `/` → GET only (serve the HTML; read `ui/index.html` at startup, path relative to `import.meta.url` as now, so it resolves from `dist/`).
   - `/api/jobs` → GET or POST.
   - `/api/jobs/<id>` (regex `^/api/jobs/([^/]+)$`, decodeURIComponent inside a try) → GET only.
   - A known path with another method → `405 method_not_allowed` with an `Allow` header. Anything else → `404 not_found`.
   - Wrap the handler in try/catch: on an unexpected error, return `500 internal_error` JSON.
4. **POST validation.** Collect `fields[]` and return one 400 that lists all of them.
   - `Idempotency-Key` header present and not matching `^[A-Za-z0-9_-]{1,128}$` → field `"Idempotency-Key"`. An empty string counts as present and invalid.
   - Content-Type: take the part before `;`, trim, lowercase. It must equal `application/json`. If it is missing or different → field `body`, message "Content-Type must be application/json". Stop body checks there.
   - `JSON.parse` fails → `body`. Parsed value is not a plain object (null, array, or primitive) → `body`.
   - Any key other than input/steps/failAttempts → a field entry with that key's name ("unknown field").
   - `input` must be `typeof === 'string'`, with `length` from 1 to 1000 and `trim() !== ''`. If missing or invalid → field `input`. Store it exactly as sent; do not trim.
   - `steps` / `failAttempts`: if the key is absent, use the default (5 / 0). If present, it must satisfy `typeof v === 'number' && Number.isInteger(v)` and be in range (1–20 / 0–5); otherwise list the field. `null`, `"3"`, and `2.5` are all rejected.
5. **Create plus idempotency**, inside `tx` (BEGIN IMMEDIATE):
   - `payload = JSON.stringify({input, steps, failAttempts})` in fixed key order.
   - If there is a key, `SELECT * FROM jobs WHERE idempotency_key=?`. If found: same payload → `200` with that job; different payload → `409 idempotency_conflict`.
   - Otherwise INSERT with status `queued`, attempts 0, progress 0, run_after 0, both timestamps now → `201`.
   - The UNIQUE constraint is a backstop. As an extra guard, catch a constraint error and re-select.
6. **GET routes:**
   - The list uses `SELECT * FROM jobs ORDER BY seq DESC` → `{jobs:[...]}`. Use `seq`, not `created_at`, because timestamps can tie.
   - A single job: select by id, or `404 not_found`.
7. **Health:** `SELECT last_seen FROM heartbeat WHERE id=1`. `worker` is `'up'` if the row exists and `Date.now() - last_seen < 3000`, otherwise `'down'`.
8. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a fallback `setTimeout(() => process.exit(0), 2000).unref()`.
9. **Worker startup:**
   - Open the DB and start `setInterval(beat, 500)`, where `beat` does `INSERT INTO heartbeat(id,last_seen) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`. Call `beat()` immediately too.
   - **Recovery:** in a transaction, `UPDATE jobs SET status='queued', progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. This assumes a single worker, so any `running` row is orphaned.
10. **Claim loop** (while not stopping):
    - In `tx`: `SELECT * FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1`. If found, compute `n = min(attempts+1, 3)`, then `UPDATE ... SET status='running', attempts=n, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`.
    - The `min` means a crash-recovered job that already used 3 attempts reruns as attempt 3 and never goes past 3.
    - If nothing was claimed, sleep 200 ms.
11. **Process an attempt** (number `n`):
    - Sleep 100 ms, the first step's time.
    - If `n <= fail_attempts`, the attempt fails:
      - if `n < 3`: `status='queued', progress_completed=0, run_after=now+500`;
      - otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - Otherwise loop `i = 1..steps`: sleep 100 ms (sleep only once for step 1, since the pre-sleep already covered it), then `UPDATE progress_completed=i, updated_at`. Check `stopping` between steps.
    - At the end, in a single UPDATE: `status='completed', result_output=input.toUpperCase(), progress_completed=steps, error=NULL`.
    - Guard every UPDATE with `WHERE id=? AND status='running'`.
12. **Worker SIGTERM:**
    - Set `stopping=true`. If a job is mid-attempt, the loop exits early and runs `UPDATE jobs SET status='queued', progress_completed=0, run_after=0 WHERE id=? AND status='running'`.
    - Then clear the interval, set heartbeat `last_seen=0`, `db.close()`, and `process.exit(0)`.
    - Use an abortable sleep or a short step sleep so exit happens within about 500 ms. Add a fallback `setTimeout(exit, 3000).unref()`.
13. **UI** (`ui/index.html`):
    - Markup:
      - `<form data-testid="job-form" novalidate>` containing:
        - `<input data-testid="job-input" name="input">` with no `maxlength` or `required`;
        - `<input type="number" data-testid="job-steps" value="5">`;
        - `<input type="number" data-testid="job-fail-attempts" value="0">`;
        - `<button type="submit" data-testid="job-submit">`.
      - `<div data-testid="form-error" role="alert"></div>`, initially empty.
      - `<ul data-testid="job-list">`.
    - On submit: `preventDefault`. Convert each numeric field with `v.trim()==='' ? undefined : (isFinite(Number(v)) ? Number(v) : v)`; omit undefined, send numbers as numbers, and send unparsable text raw so the API rejects it. POST with `Content-Type: application/json`.
    - On non-2xx, set the error region's `textContent` to `error.message` plus one line per field (`field: message`). On success, clear it, clear the input, and refresh immediately.
    - Every 1000 ms (and once on load): `GET /api/jobs` and render each job as `<li data-testid="job-item" data-job-id=id>` with `<span data-testid="job-status">`, `<span data-testid="job-progress">` (`completed/total`), and `<span data-testid="job-result">` (`result.output`, or `error`, or empty).
    - Build nodes with `textContent` only (no innerHTML with user data). Keep the API's newest-first order.

## Behaviours to verify
After `npm run build`, run `DATABASE_PATH=/tmp/t/jobs.db PORT=3100 npm run start:server` and `start:worker` in two terminals, then:
- **Health:** `curl :3100/health` shows `worker:"up"`. Kill the worker; within about 3 s it shows `"down"`.
- **Create and complete:** `curl -XPOST -H 'content-type: application/json' -d '{"input":"hello","steps":3}'` returns 201 with status queued, attempts 0, progress `0/3`. Polling GET shows progress rising, then completed with `HELLO` and attempts 1.
- **Validation:** each of the following returns 400 with the named field:
  - `steps:"2"` → `steps`;
  - `failAttempts:7` → `failAttempts`;
  - `colour` → `colour`;
  - missing input → `input`;
  - `input:"   "` → `input`;
  - text/plain or missing Content-Type → `body`;
  - `{bad json` → `body`;
  - `[]` → `body`;
  - `Idempotency-Key: a b` → `Idempotency-Key`.

  The job count must not change.
- **Idempotency:** with the same key, `{"input":"a"}` followed by `{"input":"a","steps":5,"failAttempts":0}` returns 200 with the same id. A different input with that key returns 409. Restart the server and replay: still 200 with the same id.
- **Retries:** `failAttempts:1` → completed with attempts 2. `failAttempts:2` → completed with attempts 3. `failAttempts:3` → failed, error `"transient failure"`, attempts 3, result null. Only one job per input in the list.
- **Routing:** `GET /nope` → 404 `not_found`. `DELETE /api/jobs` → 405. `GET /api/jobs/xyz` → 404.
- **Crash recovery:** submit `steps:20` and `kill -9` the worker mid-run. The job is still `running`; after a restart it completes within a few seconds. Completed jobs are never touched again: their `updatedAt` stays unchanged.
- **Durability:** `kill -9` both processes and restart them. All jobs are still listed.
- **SIGTERM:** `kill -TERM` on each process exits promptly with code 0.
- **Checks:** `npm run check:smoke` and `npm run check:contract` pass.
- **UI:** open `/` and submit `steps` = 99; the error region shows `steps`. A valid job shows its status and progress changing without a reload.

## Risks
- **Holding a transaction across `await`** would block the other process (SQLITE_BUSY). Keep every `tx` callback synchronous.
- **Browser constraint validation** (`min`/`max`/`required`) would stop the form before the API sees it. Use `novalidate` and no `maxlength`, so API errors appear in `form-error`.
- **Typeof checks:** `typeof null === 'object'` and arrays are objects. Explicitly reject `null`/arrays as the body, and reject an explicit `null` for steps/failAttempts.
- **Content-Type with parameters** (`application/json; charset=utf-8`) must be accepted. Compare only the media type, case-insensitively.
- **Newest-first ordering** must use `seq` (AUTOINCREMENT), not ISO timestamps, which can collide within the same millisecond.
- **Attempt counts:** don't let attempts exceed 3 during crash recovery, and don't increment attempts on recovery itself. Only claiming increments it.
- **Imports:** keep the `.ts` extension
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
