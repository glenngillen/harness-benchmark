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
Keep the existing TypeScript entry points and commands, using Node.js built-ins exclusively. Centralize SQLite initialization and job serialization so the server and worker share one durable state model, with short transactions for submission and processing transitions. The server handles validation, routing, and the browser page; the separate worker handles processing, retries, and database heartbeats. Use browser polling to display observable progress without introducing dependencies.

## Files
- `src/db.ts`: Extend database initialization with schema, indexes, transaction helpers, and shared job queries.
- `src/jobs.ts`: Add job/payload types, strict validation, and the public job serializer.
- `src/server.ts`: Implement routing, JSON request handling, durable idempotency, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, progress persistence, retry scheduling, recovery, and heartbeats.
- `ui/index.html`: Implement the submission form, error display, job list, and polling with inline JavaScript and CSS.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the shared SQLite schema.**
   - Preserve parent-directory creation and the existing initialization order: `busy_timeout` before WAL mode.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` in both processes so either can start first. Use `synchronous = FULL` for durable commits.
   - Store jobs with an internal increasing integer primary key for deterministic ordering, a unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, creation/update timestamps, nullable unique idempotency key, and persisted `available_at` retry time.
   - Store a singleton worker heartbeat timestamp in a separate table.
   - Index queued-job selection. Use prepared statements with bound parameters.
   - Add a transaction helper that rolls back on exceptions. Never hold a transaction across a timer or request-body read.

2. **Implement shared types and serialization.**
   - Return precisely the required public fields; omit internal ordering, retry, and idempotency columns.
   - Derive `progress.total` from `steps`.
   - Return `{output: ...}` only for completed jobs and an error string only for failed jobs; otherwise return explicit `null`.
   - Generate timestamps with `new Date().toISOString()`. Preserve `createdAt` and update `updatedAt` on each state/progress change.
   - Order listings by internal insertion sequence descending; processing uses ascending order among eligible queued jobs.

3. **Implement validation before database mutation.**
   - Read the request body asynchronously, decode UTF-8, and parse JSON with caught parse errors.
   - Accept the `application/json` media type case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with field `"body"`.
   - Require a non-null, non-array object. Malformed JSON and invalid top-level values receive field `"body"`.
   - Collect all detectable field errors rather than returning on the first failure. Enumerate unknown own properties, including names such as `__proto__`.
   - Require string input with JavaScript length 1–1000 and a nonempty `.trim()` result. Store the original string unchanged.
   - Apply numeric defaults only when the property is absent. Reject `null`, strings, booleans, fractions, and out-of-range values using type checks and `Number.isInteger`.
   - Validate any supplied `Idempotency-Key` against the exact regex, reporting `"Idempotency-Key"` on failure. Reject duplicate key headers rather than selecting one silently.
   - Return `400` with `error.code`, a useful message, and a `fields` array containing `{field, message}` entries. Invalid requests must neither create jobs nor reserve keys.

4. **Implement atomic submissions and API routes.**
   - For valid submissions, use `BEGIN IMMEDIATE` to check the key and insert if necessary. Enforce uniqueness in SQLite as well as application logic.
   - Compare the normalized `input`, `steps`, and `failAttempts` directly with the original job’s immutable fields.
   - An existing matching key returns the current original job with `200`; a different payload returns `409 idempotency_conflict`. Requests without keys always insert.
   - Create IDs with `crypto.randomUUID()`, initialize queued state with zero attempts/progress and null result/error, and return `201`.
   - Capture the inserted job inside the transaction before committing, so the creation response remains the required queued snapshot even if the worker immediately claims it.
   - Implement GET collection/detail routes and `/health`. Health reads the persisted heartbeat and reports up only when its age is at most three seconds.
   - Classify known paths before method dispatch: `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`. Wrong methods receive `405`; unknown paths and missing job IDs receive `404`, with the specified codes.
   - Parse paths independently of query strings and handle malformed URL encoding without crashing.
   - Preserve the existing UI file resolution relative to `import.meta.url`, which works from `dist/server.js`.
   - Centralize JSON responses and catch asynchronous handler failures so unexpected errors produce a JSON error envelope rather than an unhandled rejection.

5. **Implement the worker state machine.**
   - Write a heartbeat immediately after initialization and refresh it every 500 ms, including while idle, processing, or waiting for retries.
   - Poll for eligible queued jobs every 100 ms. Select the oldest where `available_at <= now`.
   - Atomically claim one job in a short transaction: set running, increment attempts, reset completed steps, clear result/error, and update the timestamp. Process only one job at a time.
   - Await approximately 100 ms per step using asynchronous timers.
   - At the first step, before recording any progress, apply the transient-failure condition `attempts <= failAttempts`.
   - If that condition holds before attempt three, atomically return the same job to queued with zero progress, null result/error, and `available_at = now + 500 ms`.
   - On the third simulated failure, atomically set failed with error `"transient failure"` and null result.
   - Otherwise persist progress after each step. On the last step, atomically store final progress, completed status, and `input.toUpperCase()`.
   - Retry eligibility must survive restarts. Delayed retries should not prevent other eligible jobs from being processed.

6. **Handle recovery and shutdown explicitly.**
   - On worker startup, recover any previously running job before accepting fresh queued work. For the specified single-worker deployment, such a row belongs to the interrupted worker.
   - Replay the interrupted durable attempt from step zero, retaining its recorded attempt number. Treat this as continuation of that attempt, not a simulated failure or an extra retry; this also permits recovery after interruption during attempt three without exceeding the retry budget.
   - Apply the same first-step failure rule during replay. Once its transition commits, normal queued retry handling resumes.
   - Never reset or reprocess completed/failed rows. Do not perform recovery from server startup.
   - On SIGTERM/SIGINT, stop worker claims, finish the current attempt and commit its outcome, clear heartbeat scheduling and the heartbeat row, then close SQLite. A running attempt takes at most about two seconds; do not wait through future retry delays.
   - For the server, stop accepting requests, allow active handlers to finish, close remaining connections after a bounded grace period, and then close SQLite.
   - Abrupt termination requires no cleanup: committed transitions and startup recovery provide correctness.

7. **Build the browser page.**
   - Include every required `data-testid`, with one `job-item` per job carrying `data-job-id`.
   - Use a textarea for input and editable numeric controls with defaults 5 and 0.
   - Use `novalidate` so browser constraints do not suppress API validation. Send numeric values using `Number(...)`; map empty numeric fields to `null` so blank values are rejected instead of silently becoming zero.
   - Clear `form-error` before submission and after success. On rejection, show the API message and every field name/message in the region with `role="alert"`.
   - Fetch jobs immediately on load and after successful submissions; poll every 500 ms.
   - Prevent overlapping list fetches or discard stale responses so older results cannot overwrite newer state.
   - Render status, exact `completed/total` progress, and result/error text as specified. Preserve server ordering.
   - Use DOM creation and `textContent` for submitted input, output, and errors to avoid HTML injection. Keep polling failures separate from submission-validation errors.

8. **Build and verify the completed implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the supplied checks with temporary local scripts or manual requests using a disposable database; the existing suites do not cover recovery, browser behavior, or the full validation matrix.
   - Do not modify fixed files or add dependencies to support verification.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate trials with a custom port and a database under a nonexistent directory. Verify readiness within ten seconds and simultaneous startup without SQLite lock failures.
- **Job shape and defaults:** Submit `{"input":"hello"}` and verify queued response, defaults, null fields, ISO timestamps, and consistent detail/list representations.
- **Validation:** Exercise missing/blank/oversized input, Unicode string-length boundaries, arrays/null/primitives, malformed JSON, missing/wrong content type, unknown fields, numeric strings, fractions, nulls, and invalid keys. Verify all detectable offending fields appear and job count stays unchanged.
- **Routing:** Test unknown paths, missing IDs, query strings, and wrong methods on each known path, checking status, code, and JSON content type.
- **Idempotency:** Replay omitted versus explicit defaults, change each payload field, issue simultaneous identical requests, and replay after restarting the server. Verify exactly one job for a key and distinct jobs without keys.
- **Processing:** Poll a 20-step job frequently enough to observe running state and intermediate progress; verify step timing, pickup latency, final uppercase output, and FIFO selection.
- **Retries:** Test `failAttempts` values 0, 1, 2, 3, and 5. Verify attempts 1/2/3 for successful cases, terminal failure at 3 otherwise, zero progress on simulated failures, and observable queued retry delays.
- **Heartbeat:** Verify up during long jobs and idle periods, down within three seconds after killing the worker, and up again after restart.
- **Durability:** Restart both processes against the same database after graceful shutdown and SIGKILL. Kill the worker during an attempt and during retry delay; verify recovery, preserved IDs, correct terminal states, and no duplicate results. Include interruption during attempt three.
- **Terminal-state stability:** Restart the worker with completed and failed jobs present and verify their attempts, results, and timestamps remain unchanged.
- **UI:** Submit through the browser, confirm numeric JSON values, inspect all required test IDs, observe progress within two seconds, and trigger multiple validation errors. Verify text resembling HTML renders literally.
- **Shutdown:** Send SIGTERM while idle and active; verify bounded clean exits and successful reopening of the same database.

## Risks
- **SQLite contention:** Both processes initialize and write concurrently. Keep transactions short, retain the busy timeout before WAL initialization, and use database uniqueness for ide
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
