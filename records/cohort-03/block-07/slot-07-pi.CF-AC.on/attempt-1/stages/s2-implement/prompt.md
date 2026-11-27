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
Use `node:sqlite` as the sole communication and persistence mechanism between the HTTP server and worker. Centralize schema initialization, job serialization, and transactional state changes so either process can start first. Keep the existing entry points and commands, and implement the browser page with inline JavaScript that polls the API. Use short database transactions, asynchronous processing delays, and persisted retry deadlines so progress remains observable and restarts preserve work.

## Files
- `src/db.ts`: Extend database initialization with shared schema, prepared queries, transactions, serialization, and persisted worker heartbeat.
- `src/jobs.ts`: Add job and request types, strict validation, normalized payload comparison, and API error helpers.
- `src/server.ts`: Replace the placeholder with routing, JSON request handling, job endpoints, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Replace the placeholder with sequential processing, heartbeat updates, retries, restart recovery, and shutdown handling.
- `ui/index.html`: Build the submission form and automatically refreshed job list with all required test IDs.
- Leave package files, TypeScript configuration, `.gitignore`, `TASK.md`, and `checks/` unchanged.

## Steps
1. **Implement the shared database schema.**
   - Preserve directory creation and the existing `busy_timeout`-before-WAL initialization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` in either process.
   - Store jobs with an integer insertion sequence, unique server-generated UUID, status, exact input, steps, fail-attempt limit, attempts, completed steps, output, error, creation/update timestamps, nullable unique idempotency key, and retry eligibility time.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first processing, including jobs created in the same millisecond.
   - Store heartbeat time separately from jobs. Use epoch milliseconds for scheduling and heartbeat comparisons, ISO strings for public timestamps.
   - Expose one serializer that returns exactly the required job shape, deriving `progress.total` from `steps` and returning explicit `null` values for absent result/error.
   - Use parameterized SQL. Roll back transactions on exceptions; never hold a transaction across an asynchronous wait.

2. **Implement strict submission validation.**
   - Accept `application/json` case-insensitively, allowing parameters such as `charset=utf-8`; reject missing or other media types with a `body` field error.
   - Read the complete body asynchronously and catch malformed JSON, stream failures, and non-object values, including arrays and `null`.
   - Inspect own properties and list every unknown or invalid field. Use property presence to apply defaults only when fields are absent; do not silently default `null`.
   - Validate input using JavaScript string length and `trim()` only to detect whitespace-only input. Preserve the original input.
   - Require actual integer numbers in the specified ranges, without coercion.
   - Validate an explicitly present `Idempotency-Key` against the exact regex, including rejecting empty and duplicate header values. Report it as `"Idempotency-Key"`.
   - Aggregate independently detectable errors, including header errors, into `invalid_request.fields`. Invalid submissions must not reserve keys or insert jobs.

3. **Implement transactional creation and replay.**
   - After validation, normalize to `{ input, steps, failAttempts }` in a fixed order.
   - In a short `BEGIN IMMEDIATE` transaction, look up any supplied key. Compare the three normalized values directly.
   - Return the existing job with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert a queued job with attempts/progress zero and null result/error, using `crypto.randomUUID()`.
   - Capture the created job representation inside the transaction, commit, and return that snapshot with `201`. This ensures the creation response remains queued even if the worker immediately claims it.
   - Enforce key uniqueness in SQLite as well as application logic. Use SQL `NULL` for submissions without keys so they always create new jobs.

4. **Complete HTTP routing and process lifecycle.**
   - Dispatch by parsed pathname, then allowed method: `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`.
   - Serve `/` as HTML using the existing `new URL('../ui/index.html', import.meta.url)` path, which also works from `dist/server.js`.
   - Return JSON for API responses and errors, using the required envelope and meaningful messages. Return `405` for a wrong method on a recognized route, even when a job ID does not exist; return `404` for unknown routes or missing jobs on GET.
   - Implement list and detail reads through the shared serializer.
   - Report worker up only when a stored heartbeat is no more than 3 seconds old; no heartbeat means down.
   - Catch asynchronous handler failures to prevent unhandled rejections. Return a JSON internal error when a response is still possible.
   - On `SIGTERM` or `SIGINT`, stop accepting connections, finish active handlers, close the database, and exit. Bound draining so idle or incomplete requests cannot keep shutdown alive indefinitely.

5. **Implement worker scheduling, progress, and retries.**
   - Write an initial heartbeat and refresh it approximately every 500 ms, including during processing and retry waits.
   - Use one processing loop, polling approximately every 100 ms when idle. Select the oldest eligible queued job; delayed retries must not prevent other eligible work.
   - Claim a job transactionally: set running, increment attempts, reset progress to zero, clear result/error, and update its timestamp.
   - Wait approximately 100 ms for each step using asynchronous timers. On the first step, fail before updating progress if `attempts <= failAttempts`.
   - For a transient failure before attempt 3, persist queued status and a retry deadline 500 ms in the future. Keep error/result null and progress zero.
   - On the third transient failure, atomically set failed with error exactly `"transient failure"` and null result.
   - After every successful step, persist completed progress and updated time. On the final step, atomically persist full progress, completed status, and the JavaScript `input.toUpperCase()` output.
   - Keep heartbeat writes separate from job timestamps. Do not use HTTP, IPC, or shared in-memory state to coordinate processes.

6. **Handle interrupted work and shutdown explicitly.**
   - Under the task’s single-worker model, recover persisted running work immediately at worker startup, before claiming ordinary queued jobs.
   - Re-execute an interrupted attempt from progress zero using its persisted attempt number. Treat this as recovery of that attempt, rather than consuming another transient-failure attempt; ordinary queued-to-running attempts still increment the counter.
   - This recovery policy prevents a crash during a successful third attempt from either creating attempt 4 or incorrectly producing a transient failure. Persist the reset before executing steps.
   - Preserve retry deadlines across restarts and never select completed or failed jobs.
   - On termination, stop claiming jobs, let any current short database operation finish, stop timers, clear the heartbeat, and close SQLite. An interrupted job can remain running for startup recovery.
   - Ensure abrupt termination requires no cleanup to recover: all essential state must already be committed.

7. **Build the browser interface.**
   - Add labeled input, steps, and fail-attempt fields with defaults 5 and 0, plus every specified `data-testid`.
   - Use a form with `novalidate` so API validation can produce the required visible rejection. Preserve text input exactly and send numeric field values as numbers; handle blank or invalid numeric entries so they reach the API as invalid values rather than disappearing into defaults.
   - Keep `form-error` permanently present with `role="alert"`. Clear it before submission and on success; on rejection show the API message and every offending field’s name/message.
   - Fetch jobs immediately on load and poll every 500 ms using a single non-overlapping refresh loop. Refresh promptly after successful submission.
   - Render jobs in API order, setting `data-job-id` on each item and the specified status, progress, and result elements.
   - Use DOM creation and `textContent` for submitted input, output, errors, and IDs. Do not interpolate user content into HTML.
   - Keep polling failures separate from submission validation errors. Prevent stale overlapping responses from replacing a newer list.

8. **Build and validate without changing the fixed checks.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Supplement the supplied checks with temporary local scripts using Node built-ins and browser inspection. The existing contract suite explicitly omits restart durability, UI behavior, and many validation cases.

## Behaviours to verify
- **Startup and configuration:** Start each process first using a fresh nested `DATABASE_PATH`; confirm directory creation and readiness within 10 seconds. Check default configuration separately.
- **Response shape and ordering:** Submit multiple jobs while the worker is stopped; verify queued creation snapshots, exact nulls, ISO timestamps, defaults, unique IDs, and newest-first lists.
- **Validation:** Exercise malformed JSON, empty bodies, arrays, null, missing/wrong content type, whitespace-only and oversized input, numeric strings, fractions, range violations, unknown fields, invalid keys, and multiple simultaneous field errors. Verify no inserted jobs.
- **Idempotency:** Compare omitted versus explicit defaults; issue concurrent same-key requests; restart the server and replay. Verify one ID, matching replay status 200, conflicts 409, and separate jobs without keys.
- **Routing:** Exercise unknown paths, missing IDs, and wrong methods on every known route; confirm JSON errors and required status codes.
- **Observable processing:** Poll a 20-step job frequently; observe running status and intermediate committed progress. Verify idle pickup within 1 second and approximately 100 ms per step.
- **Retries:** Test failAttempts 0, 1, 2, 3, and 5. Verify expected attempt counts, zero progress during failed attempts, queued retry delays, exact terminal errors, and no duplicate jobs.
- **Heartbeat:** Verify up during idle and active work; terminate or kill the worker and verify down after at most 3 seconds from its last heartbeat.
- **Durability:** Restart both processes against the same database after graceful shutdown and `SIGKILL`. Kill the worker during processing, a retry delay, and a third attempt; verify recovery, stable IDs, retained terminal jobs, and no repeated terminal processing.
- **UI:** Submit valid and invalid jobs through the form, inspect all test IDs and field names in errors, observe updates within 2 seconds, and verify HTML-like input renders as literal text.
- **Shutdown:** Send `SIGTERM` while idle and busy; confirm prompt exits without database errors or lost committed state.

## Risks
- **Recovery semantics:** The task does not explicitly define whether crash recovery consumes another attempt. Implement and document the interrupted-attempt recovery policy above consistently; never decrement attempts or turn an interruption into a fabricated transient failure.
- **SQLite contention:** Both processes initialize and write the same file. Preserve busy timeout ordering, use short transactions, and avoid sleeping while holding locks.
- **Creation-response race:** Reading a newly inserted job after committing can expose running status in a `201` response. Capture the queued representation before committing.
- **Validation gaps:** Truthy defaults, numeric coercion, trimming stored input, and re
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
