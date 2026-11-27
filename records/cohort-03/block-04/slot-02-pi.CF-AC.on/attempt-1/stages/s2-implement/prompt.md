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
Extend the existing TypeScript entry points using only Node.js built-ins, preserving the current commands and file layout. SQLite will hold jobs, idempotency keys, retry deadlines, and worker heartbeat state; both processes will initialize the same schema independently. Use short synchronous transactions for state changes and asynchronous timers for processing, with no database transaction held during a delay. Serve a small browser interface from the existing HTML file and poll the API for updates.

## Files
- `src/db.ts`: Extend database initialization with shared schema, prepared queries, transactions, and job serialization.
- `src/jobs.ts`: Add shared job and payload types, request validation, and payload normalization.
- `src/server.ts`: Implement HTTP routing, submission and idempotency handling, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, persisted retries, heartbeat updates, interrupted-attempt recovery, and shutdown.
- `ui/index.html`: Implement the form, error region, job list, styling, and polling JavaScript.
- Leave all fixed files and `checks/` unchanged. No dependencies are needed.

## Steps
1. **Define the shared database model.**
   - Preserve parent-directory creation and the existing `busy_timeout` before enabling WAL.
   - Initialize tables and indexes with `IF NOT EXISTS`, so either process can start first, including simultaneous startup.
   - Store jobs with an integer insertion sequence, unique public UUID, status, input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, and numeric retry deadline.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first processing, including jobs created within the same millisecond.
   - Add a singleton worker heartbeat row with a numeric timestamp.
   - Centralize row conversion to the exact public shape. Keep database-only fields private; derive `progress.total` from `steps` and return explicit `null` values for unavailable result/error.
   - Use parameterized SQL and a transaction helper that rolls back on exceptions.

2. **Implement validation before any database mutation.**
   - Read the complete request body, decode UTF-8, and parse JSON. Reject malformed JSON, null, arrays, and primitives with a `"body"` field error.
   - Require the media type `application/json`, allowing ordinary parameters such as `charset=utf-8` and case-insensitive media-type matching. Missing or incorrect content type yields a `"body"` error.
   - Check every own property against the allowed field names; report each unknown field.
   - Validate `input` with JavaScript `.length`, preserving its original value. Use `.trim()` only to reject whitespace-only input.
   - Require actual integer numbers in the documented ranges. Apply defaults only when a property is absent, never for explicit null, empty strings, or other invalid values.
   - Validate any supplied idempotency key against the exact regular expression, including rejecting an empty key.
   - Accumulate independent field errors, including header errors, and return `400 invalid_request` with `fields`. Do not let invalid submissions become replays or conflicts.
   - Normalize successful validation to `{ input, steps, failAttempts }`.

3. **Implement HTTP routes and atomic submission.**
   - Match the pathname separately from the method. Known paths are `/`, `/health`, `/api/jobs`, and a single ID segment under `/api/jobs/`.
   - Return `405 method_not_allowed` for unsupported methods on known routes and `404 not_found` for unknown paths. A missing job on a supported detail request also returns `404`.
   - Use one JSON response helper for API successes and all errors; serve `/` as HTML using the existing module-relative `../ui/index.html` path.
   - For creation, generate the public ID with `randomUUID()` and set initial values to queued, attempts/progress zero, and result/error null.
   - Handle key lookup, payload comparison, and insertion inside `BEGIN IMMEDIATE`. The unique nullable key constraint provides a second safeguard against duplicate creation.
   - Compare normalized payload fields directly with the stored original fields. Matching keys return the original job’s current state with `200`; mismatches return `409`; absent keys always insert.
   - Capture the newly inserted job within the transaction and return that queued snapshot with `201`, even if the worker claims it immediately afterward.
   - Implement list/detail reads through the common serializer.
   - Report worker `"up"` only when its stored heartbeat is at most 3 seconds old.
   - Catch request-handler errors so malformed requests and unexpected failures do not terminate the server. Unexpected failures should receive a JSON `500` response when a response remains possible.

4. **Implement the worker’s durable state machine.**
   - Write a heartbeat immediately after initialization and approximately every 500 ms during both idle and active periods.
   - Poll for work every 100 ms. Select the oldest eligible queued job whose persisted retry deadline has passed.
   - Claim it in a short transaction: set running, increment attempts, reset progress, clear output/error and retry deadline, and update the timestamp.
   - Process only one job at a time. Await approximately 100 ms per step, then commit the completed-step count and updated timestamp.
   - On the first step, before recording progress, simulate failure when the current attempt number is at most `failAttempts`.
   - For attempts 1 and 2 that fail, atomically return the job to queued with progress zero, null result/error, and a persisted deadline 500 ms in the future. Other eligible jobs may run while this job waits.
   - On the third simulated failure, atomically set failed with error exactly `"transient failure"`, attempts 3, and null result.
   - For success, commit the final progress, completed status, and JavaScript `input.toUpperCase()` output together. Never select completed or failed rows for processing.

5. **Make restart and shutdown behavior explicit.**
   - At worker startup, recover any persisted running job before claiming queued work. Replay its interrupted attempt from step zero using its recorded attempt number; a crash is an interruption, not an additional simulated failure. This also allows an interrupted third attempt to finish without inventing a fourth retry.
   - Keep the recovered job running, reset its progress durably, and apply the same first-step failure rule. Do not reset its historical attempt count or touch terminal jobs.
   - This recovery assumes the task’s single worker process; do not add a distributed lease system unless supporting simultaneous workers becomes a requirement.
   - On worker `SIGTERM`/`SIGINT`, stop claiming jobs, stop heartbeat scheduling, and finish the currently executing attempt before closing SQLite. With at most 20 steps at 100 ms, this remains bounded. A retry transition remains persisted for the next launch.
   - Clear the heartbeat on graceful exit. After `SIGKILL`, let the old heartbeat expire naturally.
   - On server termination, stop accepting connections, allow active handlers to settle, close connections within a bounded grace period, then close SQLite. Prevent late handlers or timers from accessing a closed database.
   - Keep every state transition committed independently so abrupt termination cannot lose earlier progress, retry scheduling, or results.

6. **Build the browser page.**
   - Add the exact required test IDs: form, input, steps, fail-attempts, submit, alert region, list, and each per-job status/progress/result element.
   - Set numeric field defaults to 5 and 0. Submit input unchanged and numeric fields as numbers; handle blank numeric values explicitly so they do not silently become valid zero values.
   - Use `novalidate` so browser-native validation does not prevent the API’s rejection messages from reaching the required error region.
   - On submission, clear the previous form error, disable the button while pending, and send JSON to `/api/jobs`.
   - On API rejection, show the error message and every returned field name/message in `form-error`, which must have `role="alert"`. Keep the region empty after a successful submission.
   - Fetch jobs immediately on page load, after successful submission, and approximately every 500 ms. Prevent overlapping refreshes or stale responses from overwriting newer state.
   - Render newest first with one `job-item` carrying `data-job-id` per job. Show status, `completed/total`, and output/error exactly as specified.
   - Insert all user-derived strings with `textContent`, preserving output whitespace where useful. Recover from transient polling failures without stopping future refreshes.
   - Include accessible labels and a compact responsive layout; keep scripts and styles inline to avoid additional asset routes.

7. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The disclosed checks cover basic startup, creation, a few validation cases, completion, one retry, and idempotency. Perform the additional checks below against a separate temporary database.
   - Do not modify the provided checks or fixed configuration files.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate runs, then start both simultaneously against a nonexistent database directory. Confirm readiness within 10 seconds and the configured port/path.
- **Validation:** Submit malformed JSON, arrays/null, missing or incorrect content type, unknown properties, numeric strings, fractions, range violations, whitespace input, and invalid keys. Verify all applicable field names and no new rows.
- **Exact string handling:** Submit leading/trailing whitespace, Unicode, and boundary-length strings. Confirm input is preserved and output matches JavaScript uppercase behavior.
- **Idempotency:** Compare omitted defaults with explicit defaults, vary each payload field, send concurrent requests with one key, and replay after server restart. Confirm one job per key and new jobs for requests without keys.
- **Routes and representation:** Check all documented status codes, wrong methods, unknown paths, missing IDs, JSON content types, explicit nulls, timestamps, and deterministic list order.
- **Processing timing:** Poll a 20-step job frequently enough to observe running progress. Confirm pickup within 1 second, approximately 100 ms steps, progress reset on attempts, and sequential processing.
- **Retries:** Test `failAttempts` from 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0, 1, and 2; failure on attempt 3 for values 3–5. Observe queued retry waits and no duplicates.
- **Restart durability:** Kill the worker while running, including during a successful third attempt; restart against the same file and verify recovery within the deadline. Restart during a retry delay and after terminal completion. Restart both processes and verify jobs and keys remain intact.
- **Heartbeat and shutdown:** Confirm health changes to up after worker start, down after graceful stop, and down within 3 seconds of abrupt death. Confirm both processes exit promptly on `SIGTERM`.
- **Browser behavior:** Submit valid and invalid forms, inspect every required test ID, verify field names in rejection messages, and observe progress/results without reload within 2 seconds. Reload the page and confirm persisted jobs remain visible.

## Risks
- Holding a transaction during a step or retry delay blocks the other process. Commit before every asynchronous wait.
- An in-memory retry timer or idempotency map breaks restart guarantees. Store deadlines and keys in SQLite.
- Startup races can fail schema creation or WAL initialization. Preserve the busy timeout ordering and use idempotent schema s
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
