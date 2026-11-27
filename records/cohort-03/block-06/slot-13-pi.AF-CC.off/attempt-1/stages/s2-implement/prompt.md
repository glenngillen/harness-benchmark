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
Keep the existing layout: `src/db.ts` holds the shared schema and helpers, `src/server.ts` holds the `node:http` API and serves `ui/index.html`, and `src/worker.ts` is a polling worker loop. Both processes open the same SQLite file through `openDatabase()`, which already sets busy_timeout and WAL. Both run `CREATE TABLE IF NOT EXISTS` at startup, so either can start first. Every state change is a short synchronous statement or a `BEGIN IMMEDIATE` transaction, so the two processes never race. The worker writes a heartbeat row every second, and `/health` reads it. Job creation with an idempotency key happens in one transaction, with a UNIQUE index as a backstop.

## Files
- `src/db.ts`: keep `openDatabase`. Add `initSchema(db)`, a `JobRow` type, `rowToJob(row)` (builds the exact JSON shape) and `nowIso()`.
- `src/server.ts`: rewrite with routing, body reading, validation, idempotency, the job endpoints, `/health`, `/` and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, crash recovery, claim loop, step processing, retries and SIGTERM handling.
- `ui/index.html`: form, error region and job list, with inline JS that polls every second.

## Steps
1. **Schema** (`initSchema`, run by both processes right after opening; the `IF NOT EXISTS` statements are safe to run concurrently):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs (
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
     idempotency_key TEXT UNIQUE,
     run_after INTEGER NOT NULL DEFAULT 0,   -- epoch ms; retry delay
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), beat_at INTEGER NOT NULL);
   ```
   `rowToJob` returns `{id, status, input, steps, failAttempts, attempts, progress: {completed, total: steps}, result: status === 'completed' ? {output} : null, error: status === 'failed' ? error : null, createdAt, updatedAt}`. Order is always `seq DESC` for lists (newest first) and `seq ASC` for claiming (oldest first). Don't sort by timestamp, because ties are possible.

2. **Server routing**: parse `pathname` with `new URL`.
   - `/health`: GET only.
   - `/`: GET only, serves HTML. Keep the `../ui/index.html` URL; it resolves from `dist/` to `ui/`.
   - `/api/jobs`: GET or POST.
   - `/api/jobs/:id`: matches `^/api/jobs/([^/]+)$`, GET only.
   - Known path with another method: 405 `method_not_allowed`.
   - Anything else: 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` JSON.
   - All JSON responses use `application/json; charset=utf-8`.

3. **`/health`**: `SELECT beat_at FROM heartbeat WHERE id=1`. `worker` is `"up"` if the row exists and `Date.now() - beat_at < 3000`, otherwise `"down"`.

4. **POST validation**: read the full body (cap it at about 1 MB, which counts as a body error). Collect `fields` and report all of them in one response:
   - **Idempotency-Key**: if the header is present and fails `^[A-Za-z0-9_-]{1,128}$`, add field `Idempotency-Key`.
   - **Content-Type**: take the part before `;`, trim and lowercase it. It must equal `application/json`. If missing or different, add field `body` and skip parsing.
   - **Body shape**: if `JSON.parse` throws, or the result is not a plain object (null, array or primitive), add field `body`.
   - **Unknown fields**: for each key not in {input, steps, failAttempts}, add that key as a field.
   - **`input`**: `typeof === 'string'`, length 1–1000, and `input.trim() !== ''`. Store it untrimmed.
   - **`steps` and `failAttempts`**: if the key is absent, use the default (5 or 0). If present, it must satisfy `typeof v === 'number' && Number.isInteger(v)` and be in range. Explicit `null` and `"3"` are invalid.
   - If any field failed, return 400 `{error: {code: 'invalid_request', message: 'Invalid request', fields}}`.

5. **Creation and idempotency**: run `BEGIN IMMEDIATE`.
   - If there is a key, `SELECT` by `idempotency_key`. If a row exists, compare `input`, `steps` and `fail_attempts` with the normalized payload: equal means `COMMIT` and return 200 with that job; different means `COMMIT` and return 409 `idempotency_conflict`.
   - Otherwise `INSERT` with id `randomUUID()`, status `queued`, attempts 0, progress 0, `run_after` 0, and both timestamps set to `new Date().toISOString()`. Then `COMMIT` and return 201.
   - `ROLLBACK` in `catch`. If a UNIQUE violation still happens, re-select and apply the same comparison.

6. **GET endpoints**: `/api/jobs` returns `{jobs: rows.map(rowToJob)}` ordered by `seq DESC`. `/api/jobs/:id` returns the job or 404 `not_found`. Decode the id with `decodeURIComponent` inside a try block.

7. **Server shutdown**: on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Add a 2 s fallback `setTimeout(...).unref()` that exits anyway.

8. **Worker startup**:
   - Open the database and run `initSchema`.
   - Write the heartbeat immediately (`INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`), then every 1000 ms with `setInterval`. Because the job loop only awaits short sleeps, the interval keeps firing while a job runs.
   - **Recovery:** `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0, run_after=0, updated_at=? WHERE status='running'`. This assumes a single worker. Decrementing makes the interrupted attempt count as never started, so `attempts` never goes above 3 and the failAttempts rules stay consistent. Completed and failed rows are never touched.

9. **Claim loop**: while not stopping:
   - In `BEGIN IMMEDIATE`, run `SELECT * FROM jobs WHERE status='queued' AND run_after <= ? ORDER BY seq ASC LIMIT 1`. If a row is found, `UPDATE` it to `status='running', attempts=attempts+1, progress_completed=0, updated_at=now`, then `COMMIT`.
   - If nothing was found, sleep 200 ms.

10. **Processing an attempt** (n = the new attempts value):
    - **Failing attempt** (n ≤ fail_attempts): sleep about 100 ms (the first step), then fail before any progress.
      - If n < 3: `status='queued', run_after=Date.now()+500, progress_completed=0`.
      - Otherwise: `status='failed', error='transient failure', result_output=NULL`.
    - **Normal attempt**: for i in 1..steps, sleep 100 ms, then `UPDATE progress_completed=i, updated_at`. After the last step, set `status='completed', result_output=input.toUpperCase()` with `progress_completed=steps`, in one statement.
    - Before each step, check `stopping`. If set, requeue the job (`status='queued', attempts=attempts-1, progress_completed=0`) and return.
    - Guard every update with `WHERE id=? AND status='running'`.

11. **Worker shutdown**: SIGTERM/SIGINT set `stopping`. After the loop exits, run `clearInterval`, `db.close()` and `process.exit(0)`. Add a fallback forced exit after 3 s, using `unref`. Don't delete the heartbeat row; it goes stale naturally.

12. **UI** (`ui/index.html`):
    - Build a `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" type="text">` with no `required` and no `maxlength`
      - `<input data-testid="job-steps" type="number" value="5">`
      - `<input data-testid="job-fail-attempts" type="number" value="0">`
      - `<button data-testid="job-submit" type="submit">`
    - Leave out `min`, `max` and `required`, so the browser never blocks a submission. The API must do the rejecting.
    - Add `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list"></ul>`.
    - On submit, call `preventDefault`. Send `input` as-is. For each numeric field: if the trimmed value is empty, omit it; else if `Number(v)` is finite, send that number; else send the raw string so the API rejects it.
    - POST the body with `Content-Type: application/json`.
      - On a non-2xx response, set the error region's text to `error.message` plus one line per field: `${f.field}: ${f.message}`.
      - On success, clear the error region, reset the input field and refresh immediately.
    - Poll `GET /api/jobs` every 1000 ms. Render the list keyed by id: reuse an existing `<li data-testid="job-item" data-job-id=id>` or create one, and keep the DOM order newest first.
    - Each item has child spans for the input text, `job-status`, `job-progress` (`${completed}/${total}`) and `job-result`. `job-result` shows `result.output` when completed, `error` when failed, otherwise `''`.
    - Use `textContent` only, never `innerHTML` with job data.

## Behaviours to verify
Run `npm run build`, then start both processes, for example with `DATABASE_PATH=/tmp/t/jobs.db` and `PORT=3100`. Also run `npm run check:smoke` and `npm run check:contract`; read `checks/cli.ts` first to see how they find the server.
- **Health**: with only the server running, `/health` reports `worker: "down"`. Within 1 s of starting the worker it reports `"up"`, and about 3 s after `kill -9` of the worker it is `"down"` again.
- **Create and list**: `curl -XPOST -H 'content-type: application/json' -d '{"input":"hi","steps":2}'` returns 201 in the exact queued shape. `GET /api/jobs` puts the new job first, and `GET /api/jobs/<id>` returns it.
- **Validation**: `{"input":"x","steps":"2"}` lists field `steps`; `failAttempts: 7` lists `failAttempts`; `colour` lists `colour`; a missing input lists `input`; `"   "` lists `input`; `steps: 2.5` lists `steps`; a bad JSON string, `[]` and a text/plain content type each list `body`; `Idempotency-Key: a b` lists `Idempotency-Key`. The job count does not change after any of them.
- **Routes**: `DELETE /api/jobs` returns 405 and `GET /nope` returns 404, both in the error JSON shape.
- **Idempotency**: the same key and payload (`{"input":"a"}`, then `{"input":"a","steps":5,"failAttempts":0}`) returns 200 with the same id. The same key with a different input returns 409. Restart the server and replay: still 200, and still only one job.
- **Processing**: with `steps: 5`, polling shows progress 1/5 to 5/5, and the job ends completed with `result.output` uppercase and attempts 1.
- **Retries**: `failAttempts: 1` completes with attempts 2. `failAttempts: 2` completes with attempts 3. `failAttempts: 3` ends failed with `error: "transient failure"`, attempts 3 and result null. Each retry case leaves exactly one job.
- **Crash recovery**: submit `steps: 20` and `kill -9` the worker mid-run. The job stays `running`. After restarting the worker it completes within a few seconds, and completed jobs stay unchanged.
- **SIGTERM**: `kill -TERM` makes each process exit with code 0 within about 1 s.
- **UI**: open `/`, submit a job and watch status and progress update without reloading. Submit `steps` 25: `form-error` shows text containing "steps". Submit an empty input: the error names `input`.

## Risks
- **Browser validation blocks the submission**: HTML `required`, `min` or `max` would stop the form before the API sees it. Use `novalidate` and leave those attributes off.
- **Wrong type checks**: numeric strings or `null` slip through if you use `Number()` or a truthiness check. Use `typeof === 'number'` with `Number.isInteger`.
- **Ordering by timestamp**: ISO timestamps can tie at the same millisecond. Order by `seq`.
- **Too many attempts after a crash**: a recovered job could pass `attempts` 3 if the interrupted attempt still counts. Decrement it during recovery and on a SIGTERM requeue.
- **Heartbeat goes stale**: it stalls if the worker blocks. Only use async sleeps, keep the heartbeat on `setInterval`, and keep `/health` strictly under 3 s.
- **SQLITE_BUSY**: both processes write. Keep transactions short, always use `BEGIN IMMEDIA
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
