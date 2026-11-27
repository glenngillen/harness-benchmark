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
Put all the shared SQLite logic in `src/db.ts`: schema creation (run by both processes, so either can start first), turning a row into the job JSON, and the queries. `src/server.ts` becomes a `node:http` router that does strict validation and handles idempotency inside a `BEGIN IMMEDIATE` transaction, backed by a UNIQUE index on the key. `src/worker.ts` becomes a polling loop. It writes a heartbeat row every second, claims the oldest queued job that is due, runs steps of about 100 ms with a progress update after each, and handles retries with a `run_at` column. When the worker starts, it puts any `running` job back in the queue. `ui/index.html` is a single static page with inline JS. It polls `GET /api/jobs` every second and shows API errors in `form-error`.

## Files
- `src/db.ts`: keep `openDatabase` and add `migrate(db)` (create tables if missing). Add `rowToJob(row)`, `nowIso()`, the job types, and a `canonicalPayload({input,steps,failAttempts})` function that returns `JSON.stringify` with a fixed key order.
- `src/server.ts`: rewrite. Router, body reading, validation, idempotency, JSON errors, serving the UI, `/health` from the heartbeat, SIGTERM handling.
- `src/worker.ts`: rewrite. Recovery on startup, heartbeat interval, claim/process loop, retries, SIGTERM handling.
- `ui/index.html`: form plus job list with all the required `data-testid`s.

## Steps
1. **Schema** (in `migrate`, called from `openDatabase` after the pragmas):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
     input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, progress_completed INTEGER NOT NULL DEFAULT 0,
     result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     run_at INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_at, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL);
   ```
   `rowToJob` maps the columns to the exact JSON shape: `progress:{completed,total:steps}`, `result: status==='completed' ? {output} : null`, `error: status==='failed' ? error : null`. Use `crypto.randomUUID()` for ids.
2. **Server helpers:** `send(res,status,body)` (already present; it sets `application/json`) and `sendError(res,status,code,message,fields?)`.
3. **Routing** on `pathname`:
   - `/` accepts GET only and serves the HTML.
   - `/health` accepts GET.
   - `/api/jobs` accepts GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` accepts GET.
   - Any other method on those paths returns 405 `method_not_allowed`. Any other path returns 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error`.
4. **`/health`:** `SELECT beat_at FROM heartbeat WHERE id=1`. `worker` is `up` if the row exists and `Date.now()-beat_at < 3000`.
5. **POST validation:** read the whole body first. Cap it at about 1 MB; if it is too large, return 400 with field `body`. Collect all errors into `fields[]`:
   - Content-Type: take the media type before `;`, trim it and lower-case it. If it is not `application/json` (or the header is missing), add a `body` error and skip parsing.
   - `JSON.parse` fails: `body`. Parsed value is null, an array, or not an object: `body`.
   - Unknown keys: one entry per key, with field set to that key.
   - `input`: must be `typeof 'string'`, `length` from 1 to 1000, and `trim()!==''`. Missing counts as an error.
   - `steps`: if present (`!== undefined`), must be `typeof 'number'`, `Number.isInteger`, and between 1 and 20. Otherwise default to 5.
   - `failAttempts`: same rule, between 0 and 5, default 0.
   - `Idempotency-Key` header: if present (`req.headers['idempotency-key']`, including the empty string), it must match `/^[A-Za-z0-9_-]{1,128}$/`. Otherwise add field `Idempotency-Key`.
   - If `fields` is not empty, return 400 `invalid_request`.
6. **Create the job:** compute `payload = canonicalPayload(...)`. Run `db.exec('BEGIN IMMEDIATE')`, then:
   - If there is a key, `SELECT * FROM jobs WHERE idempotency_key=?`. If the row exists, COMMIT. Return 200 with the job if `row.payload===payload`, otherwise 409 `idempotency_conflict`.
   - Otherwise INSERT with status `queued`, attempts 0, run_at 0, and created/updated set to now. COMMIT and return 201 with the job.
   - ROLLBACK if anything throws. If the INSERT fails on the UNIQUE constraint, re-select and apply the same comparison.
7. **List and get:**
   - `GET /api/jobs`: `SELECT * FROM jobs ORDER BY seq DESC`, returned as `{jobs}`. Sort by `seq`, not `created_at`, because timestamps can tie.
   - `GET /api/jobs/:id`: return the job, or 404 `not_found`.
8. **Server shutdown on SIGTERM/SIGINT:** `server.close()`, `server.closeAllConnections()`, `db.close()`, `process.exit(0)`.
9. **Worker startup:** open the db (this runs migrate). Recover with one statement:
   ```sql
   UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress_completed=0,
     run_at=0, updated_at=? WHERE status='running'
   ```
   The interrupted attempt is redone, so the total stays at most 3 and the "attempt n fails if n ≤ failAttempts" rule still holds. Then write the heartbeat immediately (`INSERT ... ON CONFLICT(id) DO UPDATE SET beat_at=excluded.beat_at`) and repeat it with `setInterval(…,1000)`. The awaits in the step sleeps let the interval run.
10. **Worker loop:** `while(!stopping)`:
    - Find the next job: `SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY seq LIMIT 1`.
    - If there is none, `await sleep(200)` and loop.
    - Claim it: `UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=? WHERE id=? AND status='queued'`. Skip if `changes===0`.
    - Re-read the row to get `attempts`.
    - **Failing attempt** (`attempts <= fail_attempts`): `await sleep(100)`. If `attempts < 3`, set status `queued`, `run_at=Date.now()+500`, progress 0. Otherwise set status `failed`, `error='transient failure'`, `result_output=NULL`.
    - **Normal attempt:** for i in 1..steps, `await sleep(100)`. If stopping, break out and leave the job for recovery (or requeue it with the same decrement). Otherwise `UPDATE progress_completed=i, updated_at`.
    - **After the last step:** `UPDATE status='completed', result_output=input.toUpperCase(), progress_completed=steps`.
    - Update `updated_at` on every write.
11. **Worker shutdown on SIGTERM/SIGINT:** set `stopping`, which ends the loop within one step. Then `clearInterval`, set the heartbeat `beat_at=0`, `db.close()`, `process.exit(0)`. Also add a fallback `setTimeout(()=>process.exit(0),2000).unref()`.
12. **UI** (`ui/index.html`):
    - Markup: `<form data-testid="job-form" novalidate>` containing:
      - `<input data-testid="job-input" name="input">`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button data-testid="job-submit" type="submit">`
      - `<div data-testid="form-error" role="alert"></div>`, empty by default
      - `<ul data-testid="job-list">`
    - On submit: `preventDefault`. Build the body as `{input: value}`. For each numeric field whose value is not empty, use `Number(value)` (send the raw string if `Number` gives NaN, so the API rejects it). POST with the `application/json` header.
    - If the response is not OK, set `form-error` to `error.message` plus one line per field: `"<field>: <message>"`.
    - If it succeeds, clear `form-error`, clear the input, and refresh the list right away.
    - Poll `GET /api/jobs` every 1000 ms. Re-render the `<li data-testid="job-item" data-job-id>` elements, each with spans for `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (`result?.output ?? error ?? ''`).
    - Use `textContent` only, never innerHTML with user data.
13. Run `npm run build`, then the checks: `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and startup:** run `npm run build`. Start the server and worker in either order with a temporary `DATABASE_PATH` in a directory that does not exist yet. The directory should be created and both processes should log within 10 s.
- **Health:** `curl /health` shows `up` while the worker runs, and `down` within 3 s of `kill -TERM` on the worker.
- **Validation:** each of these returns 400 with the right `fields`:
  - `steps:"3"`, `steps:2.5`, `steps:0`, `failAttempts:6`
  - an unknown key
  - `input:"   "`, and an input of 1001 characters
  - `[]`, `null`, a malformed body
  - a `text/plain` Content-Type, and no Content-Type
  - `Idempotency-Key: bad key!`

  Afterwards, `GET /api/jobs` count has not changed.
- **Defaults:** `{"input":"a"}` returns 201 with steps 5, failAttempts 0, queued, `progress {0,5}`, result and error null.
- **Idempotency:**
  - Same key with `{"input":"a"}` and then `{"input":"a","steps":5,"failAttempts":0}`: 201, then 200 with the same id.
  - Same key with a different input: 409.
  - Restart the server and replay: still 200 with the same id.
- **Routing:** `/nope` returns 404. `DELETE /api/jobs` returns 405. `GET /api/jobs/xyz` returns 404 `not_found`.
- **Progress:** poll a job with 10 steps every 100 ms. `progress.completed` goes up step by step, and the job reaches `completed` with the output upper-cased (try `ß` → `SS`).
- **Retries:** `failAttempts:2` ends completed with attempts 3. `failAttempts:3` ends failed with `"transient failure"`, attempts 3 and result null.
- **Crash recovery:** start a job with 20 steps, `kill -9` the worker mid-run, restart it. The job completes within about 10 s plus its processing time, and attempts stay at most 3.
- **Persistence:** `kill -9` both processes and restart them. All jobs are still present, and completed jobs are unchanged.
- **UI:** open `/`. Submit a valid job and watch status and progress update without reloading. Submit steps=50: `form-error` shows `steps`.

## Risks
- **Browser validation blocking submit:** native validation could block bad values so they never reach the API. Use `novalidate`, and don't put `min`/`max`/`required` on the inputs.
- **Ordering by `created_at`:** ties at millisecond resolution break newest-first. Sort by `seq`.
- **Shutdown hangs:** keep-alive connections or the worker loop can stop the process from exiting. Use `closeAllConnections` and explicit `process.exit`.
- **`SQLITE_BUSY`:** keep `busy_timeout`, and keep transactions short. Never hold a transaction across an `await`.
- **Boolean/typeof traps:** `typeof null === 'object'` and arrays are objects. Check for both explicitly. Treat `steps: null` as a wrong type, not as missing.
- **Recovery inflating attempts:** without the decrement, an attempt-3 crash would lead to a 4th attempt or break the failAttempts semantics.
- **Import paths:** keep the `.ts` relative import extensions (tsconfig rewrites them). Keep the UI path `new URL('../ui/index.html', import.meta.url)`, which resolves from `dist/`.
- **Heartbeat freshness:** write it immediately at startup, not only after the first interval, so `up` shows quickly.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
