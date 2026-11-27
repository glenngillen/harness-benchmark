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
Use one shared `src/db.ts` module that owns the schema, row-to-JSON mapping and SQL helpers. Both processes import it, and each runs idempotent `CREATE TABLE IF NOT EXISTS` at startup, so either can start first. The server is a plain `node:http` router with strict validation. Idempotency is enforced by a `UNIQUE` idempotency-key column plus a stored canonical payload, inside a `BEGIN IMMEDIATE` transaction. The worker is a single polling loop. It writes a heartbeat row every second, requeues any `running` jobs at startup, claims the oldest due queued job atomically, and writes progress after every 100 ms step. Retries reuse the same row, which waits in `queued` with a `run_after` timestamp. The UI is a single static HTML file with inline JS. It polls `GET /api/jobs` every second and uses `novalidate` so that invalid values reach the API.

## Files
- `src/db.ts`: keep `openDatabase` (it creates the parent directory, sets busy_timeout and WAL). Add `initSchema(db)`, the `JobRow` type, `toJob(row)`, and constants (`MAX_ATTEMPTS = 3`, `HEARTBEAT_STALE_MS = 3000`).
- `src/server.ts`: rewrite with routing, validation, idempotency, health, the static UI and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, recovery, the claim/process loop, retries and SIGTERM handling.
- `ui/index.html`: form, error region, job list and polling script. It stays at `ui/index.html` because the server reads it via `new URL('../ui/index.html', import.meta.url)`, which resolves correctly from `dist/`.

## Steps
1. **Schema** (in `initSchema`, run by both processes):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE, idempotency_payload TEXT);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(name TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
   ```
   `toJob(row)` returns exactly the spec shape:
   - `failAttempts` comes from `fail_attempts`.
   - `progress` is `{completed: progress_completed, total: steps}`.
   - `result` is `{output}` when the job is completed, otherwise null.
   - `error` is the error string or null.
   - Timestamps are ISO strings from `new Date().toISOString()`.
   - Ordering always uses `seq` (newest first is `ORDER BY seq DESC`), because millisecond timestamps can tie.
2. **Server helpers:**
   - `send(res, status, body)` always sets `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - `readBody(req)` collects the chunks into a utf8 string.
3. **Routing** (`pathname` comes from `new URL`):
   - `/`: GET serves the HTML. Any other method → 405.
   - `/health`: GET only.
   - `/api/jobs`: GET or POST. Any other method → 405 `method_not_allowed`.
   - `/api/jobs/<id>` (regex `^/api/jobs/([^/]+)$`, decode the id): GET only, otherwise 405. An unknown id → 404 `not_found`.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` as JSON.
4. **Health:** `SELECT at_ms FROM heartbeat WHERE name='worker'`. Report `worker: "up"` if the row exists and `Date.now() - at_ms <= 3000`, otherwise `"down"`.
5. **POST validation.** Collect a `fields` array and return it as a whole:
   - **Content-Type:** take the header, split on `;`, trim, lowercase. It must equal `application/json`. If not → 400 with field `body`, message "Content-Type must be application/json".
   - **Idempotency-Key:** if the header is present (`req.headers['idempotency-key'] !== undefined`, which includes an empty string) and fails `^[A-Za-z0-9_-]{1,128}$`, add field `Idempotency-Key`.
   - **Body:** `JSON.parse` failure → field `body`. Parsed value is null, an array or not an object → field `body`.
   - **Object fields:**
     - Each key outside {input, steps, failAttempts} → its own field entry.
     - `input`: must be `typeof 'string'`, with `length` 1–1000 and `trim().length > 0`.
     - `steps` / `failAttempts`: if present (`!== undefined`), must be `typeof 'number' && Number.isInteger(v)` and within range. Otherwise apply the default (5 / 0).
   - If `fields` is non-empty → 400 `invalid_request` with message "Invalid request" plus `fields`. Run the header and body checks together so that all problems are reported.
6. **Create / idempotency** (inside `db.exec('BEGIN IMMEDIATE')` … COMMIT, ROLLBACK on error):
   - Build the canonical payload `JSON.stringify({input, steps, failAttempts})` in a fixed key order, after defaults are applied.
   - If a key is present, `SELECT * FROM jobs WHERE idempotency_key=?`:
     - Found with the same payload → 200 `toJob`.
     - Found with a different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT with:
     - `id = crypto.randomUUID()`, status `queued`, attempts 0, progress 0.
     - `run_after = 0`, `created_at = updated_at = now`.
     - The key and payload (NULL when there is no key; a UNIQUE column allows multiple NULLs).
   - Return 201 with the inserted row.
7. **GET list / get:** `{jobs: rows.map(toJob)}` ordered by `seq DESC`. Single job → the row or 404.
8. **Server shutdown:** on SIGTERM/SIGINT run `server.close()`, `server.closeAllConnections()`, `db.close()`, then `process.exit(0)`. Add a 2 s fallback `setTimeout(...).unref()` that also exits. Listen on `Number(process.env.PORT ?? 3000)`.
9. **Worker startup:**
   - `openDatabase()` + `initSchema`.
   - Write the heartbeat immediately (`INSERT ... ON CONFLICT(name) DO UPDATE SET at_ms=excluded.at_ms`), then every 1000 ms via `setInterval`.
   - **Recovery:** `UPDATE jobs SET status='queued', progress_completed=0, attempts=MAX(attempts-1,0), run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is voided, so it re-runs as the same attempt number and the "attempt n fails if n ≤ failAttempts" and 3-attempt rules stay consistent.
10. **Worker loop** (`while (!stopping)`):
    - **Claim:**
      ```sql
      UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
      WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1)
      RETURNING *
      ```
      Use `.get()`. If no row is returned, sleep 200 ms and loop again.
    - **Process the claimed row** (`n = attempts`):
      - **Failing attempt:** if `n <= fail_attempts`, the attempt fails at its first step with progress still 0. Sleep about 100 ms first so it behaves like a step.
        - If `n >= 3`: `status='failed', error='transient failure', result_output=NULL`.
        - Otherwise: `status='queued', run_after=Date.now()+500, progress_completed=0`.
      - **Normal attempt:** for i = 1..steps, sleep 100 ms, then `UPDATE ... SET progress_completed=i, updated_at=? WHERE id=? AND status='running'`. Then `status='completed', result_output=input.toUpperCase(), progress_completed=steps, error=NULL`.
    - If `stopping` becomes true mid-job, break out of the step loop and leave the row `running`. Startup recovery handles it.
11. **Worker shutdown:**
    - SIGTERM/SIGINT sets `stopping = true`.
    - Make the sleeps abortable via an `AbortController` (`sleep(ms, undefined, {signal})`, catching AbortError) so the process exits in under 1 s.
    - After the loop: `clearInterval`, `db.close()`, `process.exit(0)`.
12. **UI** (`ui/index.html`):
    - **Markup:**
      - `<form data-testid="job-form" novalidate>`.
      - `<textarea|input data-testid="job-input">`.
      - `<input type="number" data-testid="job-steps" value="5">` and `<input type="number" data-testid="job-fail-attempts" value="0">`.
      - `<button type="submit" data-testid="job-submit">`.
      - `<div data-testid="form-error" role="alert"></div>`.
      - `<ul data-testid="job-list">`.
    - **On submit** (`preventDefault`):
      - Build the payload: `input` is sent raw. For each numeric field, a trimmed empty value is omitted. Otherwise `Number(v)` is sent if it is finite, else the raw string, so the API rejects it.
      - POST with `Content-Type: application/json`.
      - If `!res.ok`: render `error.message` plus one line per field, `"<field>: <message>"`, into form-error.
      - On success: clear form-error, clear the input field, refresh the list immediately.
    - **Rendering:**
      - `refresh()` fetches `/api/jobs` every 1000 ms (`setInterval`) and on load.
      - Each job renders as `<li data-testid="job-item" data-job-id=id>` with spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (result.output if completed, error if failed, else ''), plus the input text.
      - Set all values via `textContent`, never `innerHTML` with user data. Keep server order (newest first).
13. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and startup:** run `npm run build && npm run check:smoke && npm run check:contract`. All checks should pass.
- **Health:** start only the server and `curl /health` → `worker:"down"`. Start the worker → `"up"` within about 1 s. Kill the worker → `"down"` after more than 3 s.
- **Validation:** curl POSTs, each expecting 400 with the fields shown and `GET /api/jobs` count unchanged:
  - no Content-Type, `text/plain`, `{bad`, `[]`, `"x"` → field `body`;
  - `{"input":"   "}` → `input`;
  - `{"input":"a","steps":"3"}` → `steps`;
  - `steps: 0 / 21 / 2.5` → `steps`;
  - `{"input":"a","x":1}` → `x`;
  - `Idempotency-Key: bad key!` → `Idempotency-Key`.
- **Idempotency:** POST `{"input":"a"}` with key K → 201. POST `{"input":"a","steps":5,"failAttempts":0}` with K → 200, same id. POST `{"input":"b"}` with K → 409. Restart the server and repeat → still 200 and the same id.
- **Processing:** POST `steps: 10` and poll the job every 200 ms. `progress.completed` should climb, then the job is `completed` with output = input uppercased (try `"straße"` → `"STRASSE"`).
- **Retries:** `failAttempts: 1` → completed with attempts 2. `failAttempts: 2` → completed with attempts 3. `failAttempts: 3` → failed, `error "transient failure"`, attempts 3, result null. The job count grows by 1 each time.
- **Crash recovery:** POST `steps: 20`. While it is running, `kill -9` the worker, then restart it → the job completes within a few seconds. Completed jobs keep the same `updatedAt`, which shows they were not reprocessed.
- **Clean shutdown:** `kill -TERM` each process → it exits with code 0 within 1–2 s.
- **UI:** open `/` and submit `steps 0` → form-error shows "steps". Submit a valid job → it appears at the top and status/progress update live.

## Risks
- **Browser validation:** without `novalidate` (or with `min`/`max`/`required` attributes), the browser blocks submission and form-error stays empty. Don't add constraint attributes, or keep `novalidate`.
- **Content-Type with charset:** `application/json; charset=utf-8` must be accepted. Parse the media type and don't compare the whole header string.
- **Idempotency race and replay order:** concurrent submissions with one key can create duplicates. Use `BEGIN IMMEDIATE` plus the UNIQUE column. Validate first: an invalid body with a known key is still a 400.
- **Newest-first ordering:** use `seq` instead of `created_at`, which can tie.
- **Lock contention:** server and worker share the file. Keep transactions short, and keep `busy_timeout` set before WAL as `db.ts` already does.
- **SIGTERM hang:** keep-alive HTTP connections or a pending `setInterval` keep the process alive. Call `closeAllConnections`, clear the timers, and call `process.exit`.
- **Crash-recovery attempt counting:** without 
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
