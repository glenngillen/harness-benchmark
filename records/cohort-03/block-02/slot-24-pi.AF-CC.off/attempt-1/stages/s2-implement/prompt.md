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
Keep the existing layout: `src/db.ts` holds the schema and shared data-access helpers, `src/server.ts` is a plain `node:http` router, `src/worker.ts` is a polling loop, and `ui/index.html` is a self-contained page with inline JS. The server and worker both open SQLite through `openDatabase()`, which already sets `busy_timeout` and WAL. They share only the `jobs`, `idempotency` and `heartbeat` tables. The worker claims jobs atomically with a conditional `UPDATE`, saves progress after each step, and stores retry timing as a `run_after` timestamp. Because of that, restarts and crashes are handled by reading database state alone. When the worker starts, it resets any job left `running` back to `queued`.

## Files
- `src/db.ts`: keep `openDatabase`, and make it also run `CREATE TABLE IF NOT EXISTS` for every table. Add a `JobRow` type, `rowToJob(row)` (builds the API shape) and `nowIso()`.
- `src/server.ts`: rewrite with routing, validation, idempotency, JSON errors, health check and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, crash recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: add the form, error region and job list with the required `data-testid`s, plus polling JS.

## Steps
1. **Schema** (in `openDatabase`, after the pragmas):
   - `jobs(id TEXT PRIMARY KEY, seq INTEGER UNIQUE, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, run_after INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`. Set `seq` with `(SELECT COALESCE(MAX(seq),0)+1 FROM jobs)` inside the insert, or use `INTEGER PRIMARY KEY AUTOINCREMENT` and keep `id` as a separate `TEXT UNIQUE` column, which is simpler. Either way, sort by `seq` so ordering stays stable when timestamps tie.
   - `idempotency(key TEXT PRIMARY KEY, payload TEXT NOT NULL, job_id TEXT NOT NULL)`.
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)`.
   - Index on `jobs(status, run_after, seq)`.
   - Generate ids with `crypto.randomUUID()`.
2. **`rowToJob`**: returns `{id, status, input, steps, failAttempts, attempts, progress:{completed: progress, total: steps}, result: status==='completed' ? {output} : null, error: status==='failed' ? error : null, createdAt, updatedAt}`.
3. **Server routing**:
   - Parse `pathname`.
   - Known paths: `/` (GET, HTML), `/health` (GET), `/api/jobs` (GET, POST), and `/api/jobs/:id` matched by `^/api/jobs/([^/]+)$` (GET).
   - A known path with the wrong method returns 405 `method_not_allowed`. Anything else returns 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` on failure.
   - Keep `readFileSync(new URL('../ui/index.html', import.meta.url))`. It resolves correctly from `dist/`.
4. **POST validation**, in this order, all returning 400 `invalid_request` with `fields`:
   - **Idempotency-Key:** if the header is present (`req.headers['idempotency-key']`) and fails `/^[A-Za-z0-9_-]{1,128}$/`, add field `Idempotency-Key`.
   - **Content-Type:** `content-type`, split at `;`, trimmed and lowercased, must equal `application/json`. Otherwise add field `body`.
   - **Body:** read it fully and `JSON.parse` it in try/catch. Malformed JSON adds field `body`. A parsed value that is not a plain object (null, array or primitive) also adds `body`.
   - **Field checks:** each unknown key adds its own name. `input` must satisfy `typeof === 'string'`, `length` between 1 and 1000, and `trim() !== ''`. `steps` must satisfy `Number.isInteger` and 1 ≤ x ≤ 20. `failAttempts` must satisfy `Number.isInteger` and 0 ≤ x ≤ 5.
   - Apply defaults only when the key is absent (`undefined`). An explicit `null` is a wrong type.
   - Collect every error before responding.
5. **Create plus idempotency**, in a single transaction (`BEGIN IMMEDIATE` … `COMMIT`, with `ROLLBACK` on error):
   - If there is a key, `SELECT` from `idempotency`. If a row exists, compare its `payload` with `JSON.stringify({input, steps, failAttempts})`, built with the keys in that fixed order. Equal payloads return 200 with the stored job. Different payloads return 409 `idempotency_conflict`.
   - Otherwise insert the job (`status 'queued'`, `run_after 0`) and, if there is a key, the idempotency row. Return 201.
   - The `PRIMARY KEY` on `key` plus `BEGIN IMMEDIATE` guarantees one job per key, even across restarts or concurrent requests.
6. **GET list and get**: `SELECT * FROM jobs ORDER BY seq DESC` returns `{jobs}`. Lookup by id returns 404 `not_found` when missing.
7. **Health**: read `heartbeat.at` and respond `worker: Date.now() - at < 3000 ? 'up' : 'down'`. A missing row means down.
8. **Server shutdown**: on SIGTERM or SIGINT, call `server.close()`, `server.closeAllConnections?.()` and `db.close()`, then `process.exit(0)`. Add a 2 s fallback exit timer marked `unref`.
9. **Worker startup**:
   - Open the database.
   - Write the heartbeat immediately (`INSERT … ON CONFLICT(id) DO UPDATE SET at=excluded.at`), then every 1000 ms with `setInterval`.
   - Recovery: `UPDATE jobs SET status='queued', progress=0, run_after=0, updated_at=? WHERE status='running'`. This is safe because only one worker runs.
10. **Worker loop**, while not stopping:
    - Claim inside `BEGIN IMMEDIATE`: `SELECT id FROM jobs WHERE status='queued' AND run_after <= now ORDER BY seq LIMIT 1`, then `UPDATE jobs SET status='running', attempts=attempts+1, progress=0, updated_at=? WHERE id=? AND status='queued'`, then `COMMIT`.
    - If there was no job, sleep 200 ms and loop again.
    - Process the claimed job. Re-read the row to get `attempts`, `steps`, `fail_attempts` and `input`.
11. **Processing**:
    - If `attempts <= fail_attempts`, the attempt fails at its first step, before any progress (an optional 100 ms sleep is fine).
      - If `attempts >= 3`: set `status='failed'`, `error='transient failure'`, `output=NULL`.
      - Otherwise: set `status='queued'`, `run_after = Date.now()+500`, `progress=0`.
    - Otherwise, for each step i = 1..steps: `await sleep(100)`, then `UPDATE progress=i, updated_at`.
    - After the last step: `status='completed'`, `output=input.toUpperCase()`, `progress=steps`.
    - Every terminal update uses `WHERE id=? AND status='running'`.
12. **Worker shutdown**: SIGTERM sets `stopping` and clears the heartbeat interval.
    - If a job is in flight, stop between steps and set it back to `queued` with `progress=0`. It is already counted in `attempts`, which is acceptable, though resetting is cleaner. Alternatively, just leave it `running` and let startup recovery handle it.
    - Then `db.close()` and `process.exit(0)`. Add a 2 s fallback exit timer marked `unref`.
13. **UI**: in a `<form data-testid="job-form">`:
    - `input[type=text] data-testid=job-input`
    - `input[type=number] data-testid=job-steps value=5`
    - `input[type=number] data-testid=job-fail-attempts value=0`
    - `button[type=submit] data-testid=job-submit`

    Outside the form, add `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list">`.

    Script:
    - On submit, call `preventDefault`. Build the body with `input` as the raw string. For each number field, use `Number(value)` if it is non-empty, otherwise omit the field and let the server default apply. Never coerce away invalid values: if `Number()` gives NaN, send the raw string so the server rejects it.
    - POST with `Content-Type: application/json`.
    - On a non-2xx response, fill `form-error` with `error.message` plus one line per field as `field: message`. On success, clear it and refresh.
    - Poll `GET /api/jobs` every 1000 ms. Re-render each `<li data-testid="job-item" data-job-id=id>` with child spans `job-status`, `job-progress` (`completed/total`) and `job-result` (`result.output`, or `error`, or empty).
    - Use `textContent`, never `innerHTML`, for user data.

## Behaviours to verify
- **Build and start:** run `npm run build && PORT=3100 DATABASE_PATH=/tmp/jt/x.db npm run start:server`, and start the worker in another terminal. Both should come up in under 10 s. `curl /health` should show `worker: up`, then `down` within about 3 s after killing the worker.
- **Validation:**
  - `curl -X POST -H 'content-type: application/json' -d '{"input":"a","steps":"3","x":1}'` should return 400 with fields `steps` and `x`.
  - Also try: no Content-Type, `text/plain`, a body of `[]`, `{bad`, `{"input":"   "}`, `steps:1.5`, `steps:21`, `failAttempts:-1`, and a bad `Idempotency-Key: a b`.
- **Idempotency:** posting key `k1` with `{"input":"a"}` returns 201. Posting `{"input":"a","steps":5,"failAttempts":0}` with `k1` returns 200 with the same id. `{"input":"b"}` with `k1` returns 409. Restart the server and replay: still 200 with the same id.
- **Processing:** polling `GET /api/jobs/:id` shows `progress.completed` increasing, then `completed` with output `"HELLO"`.
- **Retries:** `failAttempts:2` ends completed with `attempts:3`. `failAttempts:3` ends failed with `attempts:3` and error `"transient failure"`.
- **Crash recovery:** with `steps:20`, `kill -9` the worker mid-run, restart it, and the job should complete. Completed jobs keep the same `attempts` across restarts.
- **Routing:** `/nope` returns 404, `DELETE /api/jobs` returns 405, `GET /api/jobs/zzz` returns 404, and every response has the JSON content type.
- **Bundled checks:** `npm run check:smoke` and `npm run check:contract` should pass.
- **UI:** open `/`, submit an empty input, and `form-error` should show `input`. Submit a valid job and its status and progress should update live.

## Risks
- **SQLITE_BUSY between processes:** keep `busy_timeout`, keep transactions short, and use `BEGIN IMMEDIATE` for both the claim and the idempotent create. Never hold a transaction open across an `await`.
- **`node:sqlite` returns `null` and `number`/`bigint` values:** wrap them with `Number()`. Pass parameters as positional `?` values, and never pass `undefined`, which throws; use `null`.
- **Defaults vs `null`:** `{"steps": null}` must be rejected, not defaulted.
- **Content-Type such as `application/json; charset=utf-8`:** it must be accepted, so parse the media type rather than matching the whole header.
- **Validation order:** report everything in one response, and never create a job when the Idempotency-Key is invalid.
- **Shutdown hangs:** the heartbeat interval or keep-alive connections can prevent exit. Clear the interval, close connections and call `process.exit`. Checks kill the whole process group (`detached`, `-pid`), so exit promptly.
- **Retry delay:** it must be at least 250 ms and at most 2 s, and the claim query must honour `run_after`. 500 ms with a 200 ms poll stays within bounds. A newly queued job must start within 1 s, so poll at 200 ms or faster.
- **Imports:** keep the `.ts` extension, because `rewriteRelativeImportExtensions` turns it into `.js`. Keep `verbatimModuleSyntax` happy by using `import type` for types.
- **Do not edit** `package.json`, `tsconfig.json` or `checks/`.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
