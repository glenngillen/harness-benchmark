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
Keep the existing TypeScript entry points and npm commands, using only Node.js built-ins. Store jobs, retry deadlines, idempotency keys, and worker heartbeat in SQLite; both processes initialize the same schema independently. Implement a sequential worker with asynchronous step delays and short database transactions, and a browser page that polls the API every 500 ms. Preserve interrupted attempts for recovery without resetting lifetime attempt counts or reprocessing terminal jobs.

## Files
- `src/db.ts`: Extend database initialization with the shared schema, transactions, typed row conversion, job queries, idempotent creation, worker state updates, and heartbeat operations.
- `src/jobs.ts`: Add public job and submission types, payload validation, and structured API error helpers.
- `src/server.ts`: Replace placeholder handlers with routing, request parsing, validation, job endpoints, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, progress persistence, retries, interrupted-attempt recovery, heartbeat, and shutdown.
- `ui/index.html`: Add the submission form, job list, API error presentation, polling, and modest inline styling.
- Leave all fixed files and `checks/` unchanged. No dependencies or additional build steps.

## Steps
1. **Define the schema and database boundary.**
   - Preserve recursive parent-directory creation and the existing ordering of `busy_timeout` before WAL configuration.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from `openDatabase()`, so either process can start first.
   - Use a `jobs` table with:
     - Internal integer insertion sequence for deterministic ordering.
     - Unique public ID generated by `randomUUID()`.
     - Input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, and ISO creation/update timestamps.
     - Nullable unique idempotency key and normalized payload string.
     - Internal numeric `available_at` timestamp for durable retry scheduling.
   - Add a singleton worker-state row containing its most recent heartbeat timestamp.
   - Add an index supporting queued-job selection by status and insertion sequence.
   - Centralize conversion to the exact public job representation. Derive `progress.total` from `steps`; expose `{output}` only for completed jobs and an error only for failed jobs. Never expose internal columns.
   - Use parameterized SQL and a transaction helper with rollback on exceptions. Never hold a transaction across an `await`.

2. **Implement validation before any database mutation.**
   - Parse UTF-8 request bodies as JSON; empty or malformed JSON, arrays, `null`, and scalar bodies produce a `"body"` field error.
   - Require media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` field error.
   - Reject every unknown own property and collect all independently detectable offending fields.
   - Require `input` to be a string with JavaScript `.length` from 1 through 1000 and a nonempty `.trim()`. Store the original string.
   - Apply defaults only when `steps` or `failAttempts` is absent. Validate supplied values with `typeof value === 'number'` and `Number.isInteger`, then enforce their ranges.
   - Validate a present `Idempotency-Key` against the exact regex, including rejection of an empty value; use `"Idempotency-Key"` in error fields.
   - Return `400` with `error.code = "invalid_request"`, a useful message, and `{field, message}` entries. Independently validate headers even if the body is invalid.
   - Canonicalize valid payloads with a fixed property order after applying defaults, preserving input exactly.

3. **Implement atomic creation and idempotent replay.**
   - In a short `BEGIN IMMEDIATE` transaction, look up an existing key before insertion.
   - For an existing key, compare canonical payloads: return the existing job snapshot with `200`, or `409 idempotency_conflict`.
   - Otherwise insert one queued job with attempts/progress zero, null result/error, matching initial timestamps, and immediate availability.
   - Read and retain its public snapshot inside the transaction, then commit and send `201`. This ensures the creation response remains queued even if the worker immediately claims it.
   - Keep a database uniqueness constraint on the key as the final protection against concurrent submissions. Multiple null keys must be allowed.
   - Persist idempotency data for terminal jobs and across restarts; no in-memory key cache is authoritative.

4. **Complete HTTP routing and lifecycle.**
   - Match URL path separately from query parameters.
   - Support `GET /`, `GET /health`, `GET|POST /api/jobs`, and `GET /api/jobs/:id`.
   - Return lists by insertion sequence descending; fetch individual jobs by public ID.
   - Recognized paths with unsupported methods return `405 method_not_allowed`; unknown paths and missing job IDs return `404 not_found`. A method mismatch takes precedence over looking up the job.
   - Use one JSON response helper for all API successes and errors. Serve `/` as HTML using the existing `new URL('../ui/index.html', import.meta.url)` approach, which also works from `dist/server.js`.
   - Health reads the persisted heartbeat on each request and reports up only when it is at most 3000 ms old. The server never writes a worker heartbeat.
   - Catch asynchronous handler failures and return structured `500` errors where a response can still be sent; handle disconnected request streams without unhandled rejections.
   - Keep the server handle. On SIGTERM/SIGINT, stop accepting requests, allow active handlers to finish, close connections within a bounded shutdown period, then close SQLite. Do not close the database while a handler can still use it.

5. **Implement worker processing and durable retries.**
   - Write a heartbeat immediately after initialization and refresh it every 500 ms, including during processing and retry waits.
   - Run one asynchronous work loop; poll for eligible jobs every 100 ms when idle.
   - Atomically select the oldest queued job whose `available_at <= Date.now()` and claim it. Set running, increment attempts, reset progress to zero, clear output/error, and update its timestamp.
   - Await approximately 100 ms for each step. After the first delay, if the current attempt number is at most `failAttempts`, fail before incrementing progress.
   - For transient failure on attempts 1 or 2, persist queued status, zero progress, null output/error, and `available_at = now + 500 ms`. Return to the selection loop so other eligible jobs can run during the delay.
   - On the third transient failure, atomically persist failed status, attempts 3, zero progress, null output, and `"transient failure"`.
   - For successful steps, persist progress and `updatedAt` after each delay. In the final step’s update, atomically set completed status, full progress, and `input.toUpperCase()` as output.
   - Keep database operations synchronous and brief; asynchronous delays allow heartbeats and signals to run.

6. **Recover interrupted work and shut down cleanly.**
   - For the specified single-worker deployment, inspect existing running jobs at worker startup before claiming new jobs. The server must never perform recovery.
   - Replay an interrupted running attempt from step zero, retaining its already-incremented attempt number. Treat this as recovery of the existing attempt rather than starting a fourth attempt after a crash during attempt 3.
   - Persist the progress reset before replay, and apply the same transient-failure and completion rules. Never decrement attempts or reset them to zero.
   - Preserve queued retry deadlines across restart; do not make delayed retries immediately eligible.
   - On SIGTERM/SIGINT, set a stopping flag, stop claiming jobs, and leave any interrupted running job durable for startup recovery. Check the flag after each short sleep and before further mutations.
   - Clear the heartbeat timer, clear the heartbeat on orderly shutdown, and close SQLite. SIGKILL naturally leaves a stale heartbeat that expires within 3 seconds.
   - Do not introduce IPC, server-to-worker HTTP calls, or process-local queues as sources of truth.

7. **Build the browser page.**
   - Include all required `data-testid` attributes verbatim, with `form-error` carrying `role="alert"`.
   - Set numeric field defaults to 5 and 0. Use a textarea or text input for the submitted text.
   - Use `novalidate` on the form so browser constraints do not hide API rejection messages. Convert nonempty numeric values with `Number`; send empty numeric fields as an invalid value such as `null`, rather than accidentally converting them to zero.
   - Submit JSON to the API, disable the submit button while the request is pending, and clear the error region for a new submission and after success.
   - Show the API error message plus every returned field name and message. Keep polling errors separate so polling cannot erase submission errors.
   - Fetch jobs immediately on load and every 500 ms with at most one list request in flight. Refresh promptly after a successful submission; prevent older responses from overwriting newer list state.
   - Render jobs in API order with `data-job-id`, status, exact `completed/total` progress, and output/error/empty result content as appropriate.
   - Use DOM creation and `textContent` for user-controlled text, preserving Unicode and avoiding HTML injection.

## Behaviours to verify
- **Existing commands:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. These checks are necessary but do not cover the full task.
- **Independent startup:** Start worker first, server first, and both concurrently against a fresh nested database path. Confirm readiness within 10 seconds and no schema or locking errors.
- **Validation:** Send malformed JSON, missing/wrong content types, non-object bodies, unknown fields, numeric strings, nulls, fractional/out-of-range numbers, blank input, and invalid keys. Submit multiple bad fields together and verify every applicable name and no job creation.
- **String semantics:** Check preserved surrounding whitespace, Unicode uppercasing, and the 1000-character boundary using JavaScript UTF-16 length.
- **Routes:** Check every supported route, unknown paths, missing IDs, and wrong methods, including `/` and `/health`. Verify JSON error shapes and content types.
- **Idempotency:** Check omitted versus explicit defaults, changed payloads, concurrent requests using one key, server restart, and replay after job completion. Confirm one stored job; identical unkeyed requests create distinct jobs.
- **Processing:** With the worker stopped, queue several jobs; start it and observe oldest-first processing, single-job execution, attempts, intermediate progress, and completion. Poll at roughly 25–50 ms for timing checks.
- **Retries:** Exercise `failAttempts` 0 through 5. Verify success on attempts 1, 2, and 3 for values 0, 1, and 2; terminal failure on attempt 3 for values 3–5; zero progress on simulated failures; and 250–2000 ms retry delays.
- **Durability:** Stop or SIGKILL processes while jobs are queued, running, and awaiting retry; restart against the same database. Confirm recovery within the required bound, durable keys, and unchanged completed/failed jobs. Include interruption during the third attempt.
- **Heartbeat and shutdown:** Observe down without a worker, up during long jobs and retries, and down within 3 seconds after SIGKILL. Confirm clean SIGTERM exits without open timers or database errors.
- **Browser:** Submit valid and invalid forms, confirm numeric JSON values, field-specific alerts, newest-first ordering, live progress/results within 2 seconds, persistence after reload, and safe display of HTML-like input.

## Risks
- **Recovery versus retry counting:** Blindly requeueing and incrementing ever
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
