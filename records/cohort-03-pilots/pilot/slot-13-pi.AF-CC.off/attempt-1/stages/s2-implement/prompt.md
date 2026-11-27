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
Keep the three existing source files and add shared modules. `src/db.ts` creates the schema and holds the helpers both processes use. `src/server.ts` is a plain `node:http` router with strict validation and idempotency enforced by a UNIQUE column in SQLite. `src/worker.ts` is a polling loop that writes a heartbeat, claims the oldest due queued job in a `BEGIN IMMEDIATE` transaction, and writes progress after each step. Retries are rows in `queued` with a `run_after` timestamp. Crash recovery means that when the worker starts, it puts any `running` jobs back to `queued`, because only one worker exists. `ui/index.html` is one static page with inline JS that polls `GET /api/jobs` every 1 s.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL). After the pragmas, add idempotent schema creation (`CREATE TABLE IF NOT EXISTS`). Add `rowToJob(row)` and a shared `Job` type.
- `src/validate.ts` (new): `validateSubmission(contentType, rawBody, idemKey)`. It returns either `{ok:true, value:{input,steps,failAttempts}}` or `{ok:false, fields:[...]}`.
- `src/server.ts`: router, handlers, health check, SIGTERM shutdown.
- `src/worker.ts`: heartbeat, recovery, claim/process loop, SIGTERM shutdown.
- `ui/index.html`: the form, the alert region, the job list, and polling JS.

## Steps
1. **Schema in db.ts**
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, idem_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0)`. `run_after` is epoch ms.
   - `seq` is an ordering key: `Date.now()*1000 + counter`. Alternatively, use `INTEGER PRIMARY KEY AUTOINCREMENT rowid` as `seq` with `id` as `crypto.randomUUID()`. Prefer the AUTOINCREMENT version: `seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL)`.
   - Index on `(status, run_after, seq)`.
   - `rowToJob` builds the exact JSON shape: `progress:{completed:progress,total:steps}`, `result: status==='completed' ? {output} : null`, and `error: status==='failed' ? error : null`.
2. **validate.ts.** Collect every offending field before returning.
   - Content-Type: parse the media type with `split(';')[0].trim().toLowerCase()`. It must equal `application/json`. Otherwise add field `body` ("Content-Type must be application/json") and return right away.
   - Run `JSON.parse` in a try block. On failure, add field `body`. If the result is not a plain object (`null`, an array, or a primitive), add field `body`.
   - Unknown keys: one entry per key, using the key name as the field.
   - `input`: must be present, `typeof === 'string'`, have `length` from 1 to 1000, and satisfy `trim().length > 0`. Store it untrimmed.
   - `steps` / `failAttempts`: if present (`!== undefined`), require `typeof === 'number' && Number.isInteger(v)` and the range check. Otherwise apply the default. An explicit `null` is invalid.
   - Idempotency-Key: if the header is present (even empty), it must match `/^[A-Za-z0-9_-]{1,128}$/`; otherwise add field `Idempotency-Key`. If Node gives an array, treat it as invalid.
3. **server.ts router.** Parse `pathname`.
   - `/health`: GET only.
   - `/`: GET only. Serve the HTML from the existing `readFileSync`; `../ui/index.html` relative to `dist/` works.
   - `/api/jobs`: GET and POST.
   - `/api/jobs/:id`: matches `^/api/jobs/([^/]+)$`, GET only.
   - A known path with the wrong method returns `405 method_not_allowed`. Anything else returns `404 not_found`. Wrap handlers in try/catch and return `500 internal_error`. Every JSON response goes through `send`.
4. **POST handler.**
   - Read the whole body as a string. Validate it. On failure, return 400 `{error:{code:'invalid_request',message:'Invalid request',fields}}`.
   - With a key: in a transaction, `SELECT` by `idem_key`. If a row exists, compare `input`, `steps` and `fail_attempts` with the normalized payload: equal returns 200 with the job, different returns `409 idempotency_conflict`. If no row exists, INSERT and return 201.
   - Also catch a UNIQUE constraint error on INSERT and re-select (belt and braces).
   - Use `db.exec('BEGIN IMMEDIATE')` / `COMMIT` / `ROLLBACK`. `node:sqlite` is synchronous, so within one process there's no interleaving.
   - INSERT uses `status='queued'`, `attempts=0`, `progress=0`, and `created_at=updated_at=new Date().toISOString()`.
5. **GET list and GET by id.**
   - List: `SELECT * FROM jobs ORDER BY seq DESC`, mapped with `rowToJob`, returned as `{jobs}`.
   - By id: return the job, or `404 not_found`.
6. **Health.** `SELECT beat_at FROM worker_heartbeat WHERE id=1`. Report `up` if `Date.now()-beat_at < 3000`.
7. **Server shutdown.** On SIGTERM/SIGINT, call `server.close()`, `server.closeAllConnections()` and `db.close()`, then `process.exit(0)`, with a fallback timer.
8. **Worker startup.**
   - Open the db, ensure the schema, and write the heartbeat immediately.
   - Start `setInterval(beat, 500)`. The heartbeat is an UPSERT: `INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`.
   - Recovery: `UPDATE jobs SET status='queued', progress=0, run_after=0, updated_at=? WHERE status='running'`. The `attempts` count is kept. That interrupted attempt counts, so when it is re-picked, `attempts` increments.
   - If `attempts` is already ≥ 3 for a recovered running job, mark it `failed` with `"transient failure"`, but only if it was a failing attempt. Simpler: just requeue it. Then when claiming, if `attempts >= 3`, the next attempt would be a 4th. To avoid that, on recovery set `failed` when `attempts >= 3 && attempts <= fail_attempts`; otherwise requeue. Acceptable simplification: let a recovered job have a fresh attempt even if this makes `attempts` reach 4 for jobs that weren't going to fail. Recommended rule: requeue, and on claim cap at 3, so a job with `attempts>=3` that is claimed runs without incrementing past 3 (`attempts = MIN(attempts+1, 3)`).
9. **Worker loop.** Run `while (!stopping)`.
   - Claim in `BEGIN IMMEDIATE`: `SELECT * FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq ASC LIMIT 1`. If found, `UPDATE status='running', attempts=MIN(attempts+1,3), progress=0, updated_at=now`, then COMMIT.
   - If there is no job, sleep 200 ms.
   - Process: let `n` be the new `attempts`.
     - If `n <= fail_attempts`, the attempt fails. Sleep about 100 ms (the first step), then:
       - if `n < 3`: `UPDATE status='queued', run_after=now+500, progress=0, updated_at`;
       - otherwise: `status='failed', error='transient failure', output=NULL`.
     - Otherwise, for each step `i` from 1 to `steps`: `await sleep(100)`, check `stopping`, then `UPDATE progress=i, updated_at`.
     - After the last step: `UPDATE status='completed', output=input.toUpperCase(), progress=steps`.
   - Guard every update with `WHERE id=? AND status='running'`.
10. **Worker shutdown.** On SIGTERM, set `stopping`. If a step is in flight, abandon the job by leaving it `running`; the next startup's recovery requeues it. Alternatively, requeue it immediately on stop: `status='queued', progress=0`. Then clear the interval, close the db, and `process.exit(0)` within about 1 s.
11. **UI (`ui/index.html`).**
    - `<form data-testid="job-form">` with:
      - `input[data-testid=job-input]` (text);
      - `input[type=number][data-testid=job-steps]` with value 5;
      - `input[type=number][data-testid=job-fail-attempts]` with value 0;
      - `button[type=submit][data-testid=job-submit]`.
    - `<div data-testid="form-error" role="alert"></div>`, and `<ul data-testid="job-list">`.
    - Don't add HTML `min`, `max` or `required` attributes. Use `novalidate` on the form, so the browser never blocks a submission the evaluator expects the API to reject.
    - On submit, `preventDefault`. Build the body: `input` is the raw value. For numeric fields, send `Number(value)` if `value.trim() !== ''`, and omit the field if empty. A non-numeric string becomes `NaN`, which serializes as `null`, which the API rejects; fine.
    - POST with `Content-Type: application/json`.
      - If the response is not ok: set the form-error text to `error.message` plus each `field: message` line.
      - If ok: clear the form-error and refresh right away.
    - Poll with `setInterval(refresh, 1000)`. Render each `li[data-testid=job-item][data-job-id]` with spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`), plus the input text.
    - Set text with `textContent` only (no innerHTML from data).
12. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and start:** `npm run build`, then start both processes with `PORT=3100 DATABASE_PATH=/tmp/t/jobs.db` in each start order. `curl /health` shows `worker:"up"`. Kill the worker, and within about 3 s it shows `"down"`.
- **Validation:** curl with each case below and check for 400 and the listed fields: `{"input":"a","steps":"3"}`, `{"input":"  "}`, `{"x":1,"input":"a"}`, `[1]`, `{bad`, a `text/plain` content-type, `steps:1.5`, `steps:21`, `failAttempts:6`, and header `Idempotency-Key: a b`. Then check that `GET /api/jobs` count is unchanged.
- **Idempotency:** post the same key twice, with and without defaults, and get 201 then 200 with the same id. A different input gives 409. Restart the server and repeat: still 200 with the same id.
- **Processing:** with `steps:10`, poll `GET /api/jobs/:id` every 100 ms and watch progress climb. The final state is `completed` with uppercase output and progress 10/10.
- **Retries:** `failAttempts:2` ends `completed` with `attempts:3`. `failAttempts:3` ends `failed`, `error:"transient failure"`, `attempts:3`, `result:null`.
- **Crash recovery:** start a job with 20 steps, `kill -9` the worker mid-run, restart it, and check that the job completes. Already completed jobs are unchanged (same `updatedAt`).
- **Routing:** `DELETE /api/jobs` gives 405, `GET /nope` gives 404 `not_found`, and `GET /api/jobs/unknown` gives 404.
- **UI:** open `/` and submit an empty input. The alert shows `input`. Submit a valid job and watch status and progress update with no reload.
- **Shutdown:** `kill -TERM` exits each process promptly with code 0.

## Risks
- **Lock contention:** using `BEGIN` instead of `BEGIN IMMEDIATE` causes SQLITE_BUSY lock upgrades. Keep busy_timeout, and keep transactions short and synchronous: no `await` inside a transaction.
- **ESM path:** `import.meta.url` resolves in `dist/`; keep the `../ui/index.html` path. Imports must use `.ts` extensions, which tsconfig rewrites, as the existing code does.
- **Field naming:** don't trim the stored input. Validation errors must use `fields[].field` names exactly: `input`, `steps`, `failAttempts`, `body`, `Idempotency-Key`.
- **Ordering:** sort by the autoincrement `seq`, not by `createdAt`; jobs created in the same millisecond would tie.
- **Retry timing:** use `run_after` instead of sleeping inside the worker while holding the job. The job must show `queued` during the wait, and the delay must fall within 250 ms to 2 s (use 500 ms).
- **Attempt cap:** don't let `attempts` exceed 3 after crash recovery. Use the `MIN(attempts+1,3)` cap, and still apply the `n <= fail_attempts` rule.
- **`node:sqlite` values:** it returns INTEGER columns as numbers by default. Make sure booleans or bigints don't leak into JSON.
- **Health freshness:** the heartbeat interval must be well under 3 s. Write the first beat immediately at startup.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
