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
Keep the existing three-file layout and expand it. `src/db.ts` owns the schema, the row-to-JSON mapping and the shared queries. `src/server.ts` is a plain `node:http` router with strict validation and transactional idempotency. `src/worker.ts` runs a polling loop that claims one job at a time with an atomic `UPDATE … RETURNING`, writes progress after each step, schedules retries through a `run_after` column, and writes a heartbeat row every second. `ui/index.html` is a single vanilla-JS page that polls `GET /api/jobs` every second and updates items in place. All state is in SQLite (WAL plus `busy_timeout`, which `openDatabase` already sets), so restarts and `SIGKILL` lose nothing.

## Files
- `src/db.ts`: keep `openDatabase` (it already creates the parent directory and sets WAL and busy_timeout). Add `migrate(db)` with `CREATE TABLE IF NOT EXISTS`, plus a `JobRow` type, `rowToJob(row)`, `nowIso()`, and the heartbeat helpers. Call `migrate` inside `openDatabase` so both processes create the schema whichever starts first.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotency, `/health`, the UI route and SIGTERM handling.
- `src/worker.ts`: rewrite with the heartbeat, crash recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: the form, error region, job list and polling script.

## Steps
1. **Schema** (in `migrate`):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload TEXT)`.
   - `CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq)`.
   - `worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL)`, where `last_seen` is epoch ms.
   - `rowToJob` returns exactly the documented shape: `progress: {completed, total: steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`.
2. **Server routing.** Parse `pathname` with `new URL`.
   - `/health`: GET only.
   - `/`: GET serves the HTML. Keep reading `../ui/index.html` relative to `import.meta.url`; from `dist/` that resolves to the repo's `ui/`.
   - `/api/jobs`: GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/`: GET only.
   - A known path with the wrong method gets `405 method_not_allowed`. Anything else gets `404 not_found`.
   - Wrap every handler in try/catch and return `500 {error:{code:'internal_error',message}}`. All JSON responses use `application/json; charset=utf-8`.
3. **`/health`.** Read `last_seen` and return `worker: 'up'` if `Date.now() - last_seen < 3000`, otherwise `'down'` (also `'down'` if there is no row).
4. **POST validation.** Collect every problem into a `fields` array before responding.
   - Content-Type must match `/^application\/json\b/i`; otherwise add a `body` entry. Read the full body. On a JSON parse error (including an empty body) add a `body` entry. If the parsed value is not a plain object (null, array or primitive), add a `body` entry.
   - For each key not in `{input, steps, failAttempts}`, add an entry under that key's name.
   - `input` must be a string with `1 ≤ length ≤ 1000` and `input.trim() !== ''`. A missing `input` is an error too.
   - `steps` defaults to 5. If present it must satisfy `typeof === 'number' && Number.isInteger(v) && 1 ≤ v ≤ 20`.
   - `failAttempts` defaults to 0. If present it must be an integer from 0 to 5.
   - If the `Idempotency-Key` header is present (`req.headers['idempotency-key']`) and does not match `^[A-Za-z0-9_-]{1,128}$`, add an `Idempotency-Key` entry.
   - If anything was collected, return `400 {error:{code:'invalid_request', message:'Invalid request', fields}}`.
5. **Create the job and handle idempotency.** Build `payload = JSON.stringify({input, steps, failAttempts})` with fixed key order, after defaults are applied.
   - Run `BEGIN IMMEDIATE`. If a key was sent, `SELECT` the row by `idempotency_key`. If it exists and its payload matches, `COMMIT` and return `200` with that job. If it exists and the payload differs, `COMMIT` and return `409 idempotency_conflict`.
   - Otherwise `INSERT` with `id = crypto.randomUUID()`, `status 'queued'`, `created_at = updated_at = nowIso()`, `run_after = 0`, then `COMMIT` and return `201`. `ROLLBACK` on any exception.
   - The UNIQUE constraint on `idempotency_key` is the backstop that guarantees one job per key, across restarts as well.
6. **GET routes.** The list is `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs}`. Ordering by `seq` keeps "newest first" correct when two jobs share a timestamp. A single job is fetched by id, or `404 not_found`.
7. **Server shutdown.** On SIGTERM and SIGINT: `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`. Also set a 3 s `setTimeout(...).unref()` that forces exit.
8. **Worker startup.**
   - Open the database and write the heartbeat immediately, then every 1000 ms with `setInterval`, using `INSERT … ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen`.
   - Recover interrupted jobs: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is redone as the same attempt number, so the `failAttempts` semantics still hold and `attempts` never goes above 3. This assumes there is only one worker.
9. **Worker loop.** While not stopping:
   - Claim a job: `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
   - If nothing was claimed, sleep 200 ms. This meets the "starts within 1 s" requirement.
   - If a job was claimed:
     - If `attempts <= fail_attempts`, the attempt fails at step one. When `attempts >= 3`, set `status='failed', error='transient failure', result_output=NULL`. Otherwise set `status='queued', run_after=Date.now()+500` (500 ms is inside the required 250 ms–2 s retry delay).
     - Otherwise, for each step from 1 to `steps`: sleep 100 ms, then `UPDATE progress_completed=i, updated_at`. If `stopping` becomes true mid-job, put the job back as in step 8 (queued, `attempts-1`) and break.
     - After the last step: `status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
10. **Worker shutdown.** SIGTERM and SIGINT set `stopping`. Once the loop exits, clear the interval, close the database and exit 0.
11. **UI.**
    - `<form data-testid="job-form" novalidate>`. `novalidate` matters: browser validation must not block submissions, because the API has to be the one that rejects them.
    - Fields:
      - `<textarea data-testid="job-input">`
      - `<input type="text" inputmode="numeric" data-testid="job-steps" value="5">`
      - `<input type="text" inputmode="numeric" data-testid="job-fail-attempts" value="0">`
      - `<button type="submit" data-testid="job-submit">`
    - `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list"></ul>`.
    - On submit: `preventDefault`. For each numeric field, trim the value. If it is empty, omit the field. If `Number(v)` is finite, send the number. Otherwise send the raw string, so the API rejects it.
    - POST with `content-type: application/json`. On a non-2xx response, fill `form-error` with `error.message` followed by one line per field (`field: message`), set with `textContent`. On success, clear `form-error` and refresh the list immediately.
    - Poll `GET /api/jobs` every 1000 ms.
    - Render each job as `<li data-testid="job-item" data-job-id=id>` containing `job-status`, `job-progress` (`completed/total`) and `job-result` (the output if completed, the error if failed, otherwise `''`).
    - Reuse existing `<li>` nodes by id and reorder to match the API's order, so nodes are not thrown away on every poll.

## Behaviours to verify
- **Build and start:** `npm run build && npm run start:server` and `npm run start:worker`, starting them in either order. Both log within 10 s.
- **Health:** `curl localhost:3000/health` shows `worker: "up"` while the worker runs, and `"down"` about 3 s after it is killed.
- **Create, list and get:** POST `{"input":"hi","steps":2}` returns 201 with the queued shape. `GET /api/jobs` lists it first, and `GET /api/jobs/<id>` returns it. `GET /api/jobs/nope` returns 404 `not_found`.
- **Validation:** each of these returns 400 with the right field:
  - `steps:"2"` → `steps`
  - `failAttempts:7` → `failAttempts`
  - `colour:"blue"` → `colour`
  - missing input → `input`
  - `"   "` input → `input`
  - malformed JSON → `body`
  - `[]` → `body`
  - no Content-Type → `body`
  - bad key `a b` → `Idempotency-Key`

  Afterwards the job count is unchanged.
- **Routes:** `DELETE /api/jobs` returns 405. `GET /x` returns 404.
- **Idempotency:** with the same key, `{"input":"a"}` followed by `{"input":"a","steps":5,"failAttempts":0}` returns 201 then 200 with the same id. A different input with that key returns 409. The same replay after a server restart still returns 200.
- **Progress:** with `steps:10`, poll `GET /api/jobs/<id>` and watch `progress.completed` climb. The job ends `completed` with output `HI`.
- **Retries:** `failAttempts:1` completes with `attempts:2`. `failAttempts:2` completes with `attempts:3`. `failAttempts:3` ends `failed`, with `error "transient failure"`, `attempts 3` and `result null`. Only one job is listed.
- **Crash recovery:** start a `steps:20` job, `kill -9` the worker mid-run, restart it, and confirm the job completes. Kill both processes, restart them, and confirm every job is still there and completed jobs are not rerun.
- **Contract checks:** run `npm run check:smoke` and `npm run check:contract` (see `checks/cli.ts` for the env/args they expect).
- **UI:** open `/`, submit `steps 50`, and confirm `form-error` shows "steps". Submit a valid job and watch status and progress update in under 2 s.

## Risks
- **JSON Content-Type on every response:** every API response, including 404, 405 and 500, must set it. Use the single `send` helper everywhere.
- **HTML5 validation blocking submits:** `required`, `min`/`max` or `type=number` would stop the API from ever seeing bad input. Use `novalidate` and text inputs.
- **Heartbeat during long jobs:** use `setInterval`, not loop iterations, so `/health` stays `up` while a job runs.
- **Retry delay:** `run_after` must stay between 250 ms and 2 s. Don't block the loop sleeping. Other queued jobs may run while a retry waits.
- **Idempotency races:** use `BEGIN IMMEDIATE` plus the UNIQUE index, and always ROLLBACK on error so the connection isn't left inside a transaction.
- **Stable ordering:** newest-first ordering must use `seq`, not timestamps. Oldest-first claiming orders by `seq` ASC.
- **Shutdown:** close the HTTP keep-alive connections, or SIGTERM will hang. The worker must not sit in long sleeps (keep each step around 100 ms).
- **Booleans and floats:** `Number.isInteger(true)` is false, so booleans are rejected correctly. `2.5` must be rejected, and `typeof` must be `'number'`.
- **TypeScript imports:** keep the `.ts` import specifiers, since `rewriteRelativeImportExtensions` turns them into `.js`. Rows from `node:sqlite` come back as `Record<string, SQLOutputValue>`, so cast them to `JobRow`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
