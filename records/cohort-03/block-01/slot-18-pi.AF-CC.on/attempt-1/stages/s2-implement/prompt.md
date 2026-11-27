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
Keep the existing layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` is a `node:http` server, `src/worker.ts` is a polling loop, and `ui/index.html` is one static page with an inline script. All state is in SQLite through `node:sqlite` `DatabaseSync`, with WAL mode and the busy_timeout already set in `openDatabase`. A `jobs` table keeps an insertion sequence for ordering, a UNIQUE `idempotency_key` with a canonical payload string, and a `run_after` time (ms) for retry delays. A `heartbeat` table lets the server report whether the worker is up. The worker claims jobs with one atomic `UPDATE … RETURNING`, writes progress after every step, and on startup requeues any job left `running` by a crash.

## Files
- `src/db.ts`: keep `openDatabase`. After the pragmas, run `CREATE TABLE IF NOT EXISTS` for both tables. Add a `JobRow` type, `rowToJob(row)` that builds the exact API JSON shape, and `nowIso()`.
- `src/server.ts`: rewrite with routing, validation, idempotency, health and graceful shutdown. Keep the `../ui/index.html` read (it resolves from `dist/`).
- `src/worker.ts`: rewrite with crash recovery, heartbeat, claim/process loop, retries and graceful shutdown.
- `ui/index.html`: form, error region, job list and a polling script, using all the required `data-testid`s.

## Steps
1. **Schema** (in `db.ts`):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     idempotency_key TEXT UNIQUE, payload TEXT NOT NULL,
     run_after INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(name TEXT PRIMARY KEY, ts INTEGER NOT NULL);
   ```
   `rowToJob`: `progress: {completed: progress_completed, total: steps}`, `result: status==='completed' ? {output: result_output} : null`, `error: status==='failed' ? error : null`.
2. **Server helpers**: `send(res, status, body)` always sends `application/json; charset=utf-8`. `sendError(res, status, code, message, fields?)`. Read the body as a Buffer with a 1 MB cap; anything bigger is a 400 on `body`.
3. **Routing** (`new URL(req.url,…).pathname`):
   - `/` accepts GET only and returns HTML.
   - `/health` accepts GET only. Read `SELECT ts FROM heartbeat WHERE name='worker'`; `worker` is `"up"` if `Date.now()-ts < 3000`.
   - `/api/jobs` accepts GET (list ordered `seq DESC`) and POST.
   - `^/api/jobs/([^/]+)$` accepts GET only: decodeURIComponent the id, then return the job or 404 `not_found`.
   - Any other method on those paths gets 405 `method_not_allowed`. Any other path gets 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **POST validation**: collect `fields[]`. Do not stop at the first error, except where noted.
   - The `Idempotency-Key` header, if present (`req.headers['idempotency-key']`), must match `/^[A-Za-z0-9_-]{1,128}$/`. Otherwise add field `Idempotency-Key`.
   - The content-type, lowercased and split at `;` then trimmed, must equal `application/json`. Otherwise add `body` and respond.
   - Run `JSON.parse` in try/catch; on failure add `body`. A parsed value that is not a plain object (null, array or primitive) also adds `body`.
   - Each unknown key gets its own field entry.
   - `input` must be `typeof string`, have length 1–1000, and `trim() !== ''`.
   - `steps`, if present (not `undefined`), must pass `Number.isInteger` and be 1–20. Otherwise default it to 5. `failAttempts` works the same way with range 0–5, default 0. A `"3"` string fails `Number.isInteger`.
   - Any errors give 400 `invalid_request` with `fields`.
5. **Create and idempotency**: build the canonical `payload = JSON.stringify({input, steps, failAttempts})`.
   - If a key is present, `SELECT` by `idempotency_key`. A match with the same payload returns 200 with the job. A match with a different payload returns 409 `idempotency_conflict`.
   - Otherwise INSERT with `id = crypto.randomUUID()`, status `queued`, `run_after = 0`, and timestamps from `new Date().toISOString()`. Return 201.
   - Wrap the INSERT so a UNIQUE-constraint error re-selects and applies the same comparison. `DatabaseSync` is synchronous, so a single server is already race-free.
6. **Server shutdown**: on SIGTERM/SIGINT run `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a 2 s `setTimeout(...).unref()` force-exit as a fallback. Log `server listening on PORT` once listening.
7. **Worker startup recovery**: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. This assumes a single worker. The interrupted attempt does not count, so the cap of 3 attempts and the `n ≤ failAttempts` rule still hold.
8. **Heartbeat**: `setInterval` every 1000 ms (also once right away) runs `INSERT INTO heartbeat(name,ts) VALUES('worker',?) ON CONFLICT(name) DO UPDATE SET ts=excluded.ts`.
9. **Claim** (loop while not stopping, polling every 200 ms when idle):
   ```sql
   UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
   WHERE id=(SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1)
   RETURNING *
   ```
10. **Process a claimed job** with attempt `n = row.attempts`:
    - If `n <= fail_attempts`, sleep 100 ms and fail the attempt with progress still 0:
      - if `n < 3`: `status='queued', run_after=Date.now()+500`;
      - otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - Otherwise, for each step i = 1..steps: `await sleep(100)`, then `UPDATE progress_completed=i, updated_at`. If `stopping` becomes true between steps, requeue the job (`status='queued', attempts=attempts-1, progress_completed=0`) and leave the loop.
    - After the last step: `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Every update sets `updated_at` and includes `WHERE id=? AND status='running'`.
11. **Worker shutdown**: SIGTERM sets `stopping`. The loop then finishes or requeues the current job, clears the interval, deletes the heartbeat row (so health shows down right away), closes the db and exits 0. Add a 3 s force-exit fallback.
12. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` with:
      - `input[data-testid=job-input]`;
      - `input[type=number][data-testid=job-steps]` (value 5);
      - `input[type=number][data-testid=job-fail-attempts]` (value 0);
      - `button[type=submit][data-testid=job-submit]`.
    - `<div data-testid="form-error" role="alert"></div>`, empty by default, and `<ul data-testid="job-list">`.
    - On submit, `preventDefault`. For each numeric field: if it is empty, omit it; if `Number(v)` is finite, send the number; otherwise send the raw string so the API rejects it.
    - POST with `Content-Type: application/json`. On a non-2xx response, fill form-error with `error.message` plus one line per field (`<field>: <message>`). On success, clear form-error and refresh the list.
    - Poll `GET /api/jobs` every 1000 ms. Render each job as `<li data-testid="job-item" data-job-id=id>` containing spans for `job-status`, `job-progress` (`completed/total`) and `job-result` (`result.output`, or `error`, or empty).
    - Use `textContent` only, never innerHTML with job data, and rebuild only the list so form focus is kept.

## Behaviours to verify
- Build and start: run `npm run build`, then `PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server` and `start:worker` in either order. Both log within 10 s and `/tmp/jt` is created.
- Health: `curl :3100/health` shows `worker:"up"`. After you SIGTERM the worker it shows `"down"` within 3 s.
- Contract and smoke: `npm run check:contract` and `npm run check:smoke` both pass. Read `checks/cli.ts` for the env vars and arguments they expect.
- Validation: curl with `{"input":"x","steps":"2"}`, `failAttempts:7`, an unknown `colour`, a missing input, `[1]`, broken JSON, no content-type, and a bad key `a b`. Each gives 400 with the right `fields[].field`, and the job count stays the same.
- Idempotency: the same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}` gives 201 then 200 with the same id. A different input gives 409. The replay still works after a server restart.
- Processing: with `steps:10`, polling GET shows progress rising. The job ends `completed` with uppercase output, and `attempts` is 1.
- Retries: `failAttempts:2` gives completed with attempts 3. `failAttempts:3` gives failed with `error:"transient failure"`, attempts 3 and result null. Only one job exists.
- Crash recovery: start a `steps:20` job, `kill -9` the worker mid-run and restart it. The job completes. Completed jobs are left alone, and their `updated_at` does not change.
- 404 and 405: `GET /nope` gives 404 and `DELETE /api/jobs` gives 405, both as JSON.
- UI: open `/`, submit a valid job and watch status and progress update. Submit steps 50 and form-error shows `steps`.

## Risks
- **Relative imports**: these must keep the `.ts` extension (`./db.ts`), because the tsconfig uses `rewriteRelativeImportExtensions`. Do not switch them to `.js`.
- **Browser validation**: native constraint validation could block bad values before they reach the API. Keep `novalidate` and leave out `required`/`min`/`max`, or the UI test for API rejections can't fire.
- **Defaults vs. type errors**: `steps: null` must be rejected, not defaulted. Only `undefined` gets the default.
- **Ordering**: sort by `seq DESC`, not by timestamp. Two jobs can share the same millisecond.
- **Process exit**: an open http server, interval or db handle can keep a process alive after SIGTERM. Close everything and call `process.exit(0)`.
- **Locking**: use short statements and no long transactions across `await`, so the server's reads never wait on the worker's writes.
- **Error responses**: every one, including 404, 405 and 500, must use the JSON content-type and the `{error:{code,message}}` shape.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
