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
Use the existing Node.js HTTP server and separate worker entry points, with SQLite as their only shared communication channel. Keep all job state, retry deadlines, idempotency keys, and worker heartbeat durable in the database. Use short transactions for creation and state transitions, and asynchronous timers for processing so progress and health remain observable. Build the browser interface in the existing HTML file with plain JavaScript and periodic API polling.

## Files
- `src/db.ts`: Extend database initialization with schema creation, prepared queries, transactions, and shared job serialization.
- `src/jobs.ts` (new): Define job and normalized submission types, validation, and field-error structures.
- `src/server.ts`: Implement routing, JSON requests and responses, durable idempotency, health reporting, HTML serving, and shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, retry scheduling, restart recovery, and shutdown.
- `ui/index.html`: Add the submission form, accessible error region, job list, and polling script.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Define the shared schema and representation.**
   - Preserve `openDatabase()`’s parent-directory creation and `busy_timeout` before enabling WAL.
   - Initialize schema with `CREATE TABLE/INDEX IF NOT EXISTS` in both processes, so either can start first.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed steps, nullable output/error, ISO timestamps, nullable unique idempotency key, and retry eligibility timestamp in milliseconds.
   - Use insertion sequence for deterministic newest-first listing and oldest-first selection, including submissions sharing the same timestamp.
   - Add a singleton worker-heartbeat table storing the last heartbeat timestamp.
   - Centralize conversion from database rows to the exact public job shape. Hide internal columns, derive `progress.total` from `steps`, and expose result/error only in their appropriate terminal statuses.
   - Use parameterized statements and a transaction helper that reliably rolls back on exceptions. Never hold a transaction across an `await`.

2. **Implement complete submission validation.**
   - Parse the media type case-insensitively; accept `application/json` with optional parameters. Missing or different content types produce a `"body"` field error.
   - Read the request as UTF-8 and parse JSON with controlled error handling. Empty/malformed JSON, arrays, null, and primitive values produce `"body"` errors.
   - For an object, collect every independently invalid field rather than returning after the first problem. List unknown keys individually, including keys such as `__proto__`.
   - Require `input` to be a string with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Preserve the original input.
   - Apply numeric defaults only when a property is absent. Require actual integer numbers within the specified ranges; reject null, numeric strings, fractions, and out-of-range values.
   - Validate a present `Idempotency-Key` against the exact regex, including rejecting an empty header. Include its error alongside other detectable validation errors.
   - Return `400` with `invalid_request`, a useful message, and `fields`; perform no database writes for invalid requests.

3. **Implement API routing and atomic creation.**
   - Match pathname independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and a single job-ID segment under `/api/jobs/`.
   - Dispatch allowed methods explicitly: GET for page, health, and individual jobs; GET/POST for the collection. Return JSON `405 method_not_allowed` for other methods on these routes, with an appropriate `Allow` header. Unknown paths return JSON `404 not_found`.
   - For valid submissions, use a short `BEGIN IMMEDIATE` transaction:
     - If the key exists, compare the three normalized payload values against the stored job.
     - Equal payload: return the current representation of the original job with `200`.
     - Different payload: return `409 idempotency_conflict`.
     - Otherwise insert one queued job, with attempts/progress zero, null result/error, and equal creation/update timestamps; return `201`.
   - Keep the unique constraint on the nullable key as the database-level guarantee. Requests without a key always insert.
   - Capture the new job’s queued representation during insertion and return that snapshot, avoiding a race where the worker changes it before the creation response is constructed.
   - Implement newest-first collection reads and individual lookup with `404` for missing IDs.
   - Have `/health` read the database heartbeat on every request and report up only while it is at most 3000 ms old.
   - Preserve the existing module-relative HTML path, which also works from `dist/server.js`. Use JSON content type for all API/error responses and HTML for the page.
   - Catch asynchronous handler failures, handle aborted requests, and provide structured JSON internal errors without exposing SQL details.

4. **Implement worker scheduling, processing, and retries.**
   - Write a heartbeat immediately at startup and every 500 ms while running, including during processing and retry waits.
   - Poll for work every 100 ms when idle. In a short transaction select the oldest eligible queued job and atomically change it to running, increment attempts, reset completed steps to zero, clear result/error, and update its timestamp.
   - Process only one job at a time. Await about 100 ms per step and commit each progress increment independently.
   - If the attempt number is at most `failAttempts`, fail after the first step’s delay and before recording any progress:
     - Below three attempts: change to queued, preserve attempts, keep progress zero and result/error null, and persist `availableAt = now + 500 ms`.
     - At attempt three: change to failed with exactly `"transient failure"` and null result.
   - Skip queued jobs whose retry deadline has not arrived; allow other eligible jobs to run.
   - On successful final-step completion, atomically set progress to `steps`, status to completed, and output to JavaScript `input.toUpperCase()`. Do not use SQLite’s uppercase function.
   - Update `updatedAt` on every job-state/progress change. Never select completed or failed jobs.

5. **Implement restart recovery and clean shutdown.**
   - Under the task’s single-worker model, recover a persisted running job immediately on worker startup, before claiming new queued work.
   - Replay the interrupted logical attempt from progress zero using its stored attempt number. Do not decrement attempts, treat a crash as a simulated transient failure, or strand an interrupted third attempt. Subsequent simulated failures follow the same retry transitions as normal processing.
   - Preserve queued retry deadlines across restarts. Recovery and a maximum 500 ms remaining retry delay comfortably fit the restart deadline.
   - Register SIGTERM/SIGINT handlers. The worker stops claiming work, stops its heartbeat timer, and closes the database after its current short operation. It may leave an interrupted job running for the startup recovery path.
   - Clear the heartbeat on graceful worker exit; after SIGKILL it expires naturally within three seconds.
   - The server stops accepting connections, drains active requests, then closes SQLite. Bound shutdown for stalled connections so an unfinished request cannot keep the process alive indefinitely.
   - Keep database cleanup ordered after all timers and request handlers that could access it.

6. **Build the browser page.**
   - Add labeled controls with all required `data-testid` attributes. Default steps to 5 and fail attempts to 0.
   - Use a form with `novalidate` so browser constraints do not prevent API validation errors from appearing. Preserve input exactly, and convert numeric field values with `Number(...)`, not `parseInt`, which would silently truncate fractions.
   - Send JSON to `POST /api/jobs`; disable submission while a request is pending to prevent accidental duplicate clicks.
   - Give `form-error` `role="alert"`. Clear it before submission and after success; on rejection display the API message and every offending field name/message. Polling must not erase submission errors.
   - Load jobs immediately and refresh every 500 ms using one in-flight poll at a time. Refresh immediately after successful submission and prevent older responses from overwriting newer state.
   - Render jobs in API order, with `job-item` and `data-job-id`, plus exact status, `completed/total`, and result/error text in the required descendants.
   - Use DOM creation and `textContent` for submitted input and output. Do not interpolate user content into HTML.
   - Keep transient fetch failures from terminating future polling, and leave the form usable after errors.

7. **Build and verify without changing fixed checks.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The supplied checks cover only examples; perform the additional checks below using temporary databases, Node built-ins or HTTP requests, and a browser.
   - Review the final diff to ensure source changes are confined to `src/` and `ui/`.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both together with a fresh nested `DATABASE_PATH`; confirm readiness within 10 seconds and custom/default port behavior.
- **Validation:** Submit multiple simultaneous errors, missing input, whitespace-only input, length boundaries, Unicode strings, numeric strings, nulls, fractions, unknown fields, malformed/empty JSON, arrays, missing/non-JSON content types, and invalid keys. Verify all detectable offending fields and no new rows.
- **Routing:** Exercise unknown paths and wrong methods on every known route, including a nonexistent individual ID. Check status codes, error shape, and JSON content type.
- **Idempotency:** Replay omitted defaults versus explicit defaults; change each payload field; issue concurrent requests with the same key; restart the server and replay again. Confirm exactly one job per key. Confirm keyless duplicate submissions create separate jobs.
- **Processing and progress:** Submit a 20-step job and poll frequently; observe running status and intermediate progress, approximately 100 ms step spacing, exact input preservation, and JavaScript Unicode uppercase output.
- **Ordering and pickup:** Queue several jobs while the worker is stopped; restart it and verify oldest-first processing and newest-first listing. With an idle worker, verify pickup within one second.
- **Retries:** Test failAttempts 0 through 5. Expect completion on attempts 1, 2, or 3 for values 0, 1, or 2; otherwise failure at attempt 3. Observe queued retry waits, zero progress on simulated failures, and no duplicate job/result.
- **Health:** Check down without a worker, up while idle and busy, down after graceful exit, and down within three seconds after SIGKILL.
- **Durability:** Stop/restart both processes with the same database, gracefully and forcibly. Verify queued and terminal jobs persist, terminal jobs remain unchanged, and an interrupted running job finishes within the recovery deadline. Include interruption on attempt three and during a retry wait.
- **Browser:** Verify every required test ID, numeric JSON values, visible field names on API rejection, newest-first order, terminal output/error, and updates within two seconds without reloading.
- **Shutdown:** Send SIGTERM to both actual Node processes and verify prompt clean exits without database-closed errors or lingering timers.

## Risks
- **Interrupted-attempt ambiguity:** The brief does not explicitly say whether crash recovery consumes another attempt. Replay the persisted logical attempt so the thre
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
