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
Use the existing TypeScript entry points with Node.js built-ins and SQLite as the only communication channel between server and worker. Put schema initialization and durable job operations in shared modules so either process can start first. Keep database transactions short, persist retry eligibility, and use asynchronous timers for processing and heartbeats. Serve a dependency-free browser page that submits jobs and polls their state.

## Files
- `src/db.ts`: Extend the existing database opener with idempotent schema initialization, prepared statements, transactions, and durable job operations.
- `src/jobs.ts`: Add shared job/payload types, validation, and explicit database-row-to-API serialization.
- `src/server.ts`: Implement routes, request parsing, validation, idempotent creation, health reporting, and shutdown.
- `src/worker.ts`: Implement sequential claiming, progress updates, retries, heartbeat, interrupted-job recovery, and shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, submission handling, and polling.
- Leave all fixed files, package scripts, and `checks/` unchanged.

## Steps
1. **Define the shared representation and SQLite schema.**
   - Retain directory creation, `DatabaseSync`, and the existing ordering of `busy_timeout` before WAL configuration. Use durable SQLite commits; do not disable synchronization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both entry points.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric `available_at` timestamp.
   - Use the insertion sequence for deterministic creation order, including jobs created in the same millisecond. List descending; claim ascending.
   - Add a singleton worker-state row containing its last heartbeat timestamp.
   - Define one serializer that emits exactly the specified public job shape, constructs `progress.total` from `steps`, and excludes internal database fields.
   - Update `updatedAt` on every job transition and progress write; preserve `createdAt`.

2. **Implement validation before any submission mutation.**
   - Read the request body asynchronously and handle malformed JSON and request-stream errors without an unhandled rejection.
   - Accept `application/json` case-insensitively, including ordinary parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` validation error.
   - Require a non-null, non-array JSON object. Use own-property checks to distinguish omitted fields from explicit `null`.
   - Collect all applicable errors: unknown property names, missing/invalid input, invalid steps, invalid failAttempts, and invalid `Idempotency-Key`.
   - Validate input using JavaScript `.length` and `.trim()` for the whitespace test, but store the original string.
   - Accept numeric fields only when their type is number, they are integers, and they fall within the specified bounds. Apply defaults only to absent properties.
   - Validate a present key against the exact regex; reject empty or ambiguous duplicate header values.
   - Always include `fields` for `invalid_request`, using `"body"` for parsing, media type, and whole-body errors. Return validation failures before checking idempotency.

3. **Implement atomic creation and idempotency.**
   - Use a synchronous `BEGIN IMMEDIATE` transaction with rollback on exceptions; never await inside a transaction.
   - For a supplied key, look up its existing job and compare the three normalized payload values directly.
   - Return that job’s current representation with `200` when equal, or `409 idempotency_conflict` when different.
   - Otherwise insert one queued job using `randomUUID()`, attempts/progress zero, null result/error, and immediate eligibility. Persist its key in the same row.
   - Enforce uniqueness in SQLite, not only in application code.
   - Capture the newly inserted queued representation before committing and return it with `201`; a fast worker must not change the creation response into a running job.
   - Submissions without keys always insert a new row.

4. **Complete HTTP routing and lifecycle.**
   - Resolve the pathname independently of query parameters.
   - Implement `GET /health`, `POST /api/jobs`, `GET /api/jobs`, and `GET /api/jobs/:id`.
   - Health reports `"up"` only when a worker-written heartbeat is at most 3 seconds old; the server never refreshes it.
   - Preserve `GET /` serving `ui/index.html` through the existing module-relative path, which also works from `dist/server.js`.
   - Determine whether a route is known before checking its allowed methods. Known paths with unsupported methods return JSON `405 method_not_allowed`; unknown paths return JSON `404 not_found`. A missing job returns `404 not_found`.
   - Use a common JSON response/error helper. Catch unexpected handler failures and return a structured `500` if a response is still possible.
   - Retain `PORT` default `3000` and `DATABASE_PATH` default `data/jobs.db`.
   - On `SIGTERM`/`SIGINT`, stop accepting connections, allow active handlers a bounded drain period, close remaining connections if needed, and close SQLite after handlers finish.

5. **Implement the worker’s durable state machine.**
   - Write an immediate startup heartbeat, then update it approximately every 500 ms, including while idle and during retries.
   - Poll eligible queued jobs every 100 ms when idle. Claim the oldest eligible row in a short transaction, setting `running`, incrementing attempts, resetting progress, and clearing output/error.
   - Process exactly one job at a time. Never hold a transaction or database lock during a timer.
   - Wait approximately 100 ms for each step. On the first step, if the current attempt number is at most `failAttempts`, fail before recording progress.
   - For a failed attempt below attempt 3, atomically set `queued`, progress zero, result/error null, and `available_at = now + 500 ms`. Persisting this deadline preserves the delay across restarts.
   - On the third simulated failure, atomically set `failed`, error `"transient failure"`, null result, and zero progress.
   - For successful steps, persist each completed-step count. Commit the final progress, completed status, and JavaScript `input.toUpperCase()` result together.
   - Skip queued jobs whose retry deadline has not arrived so other eligible jobs can run.
   - Guard updates by job ID, expected status, and attempt number to prevent accidental stale writes.

6. **Handle worker interruption and restart explicitly.**
   - Under the task’s single-worker model, recover durable `running` rows once at worker startup; server startup must never alter job states.
   - An interrupted attempt remains counted. If attempts are below 3, reset its progress and return it to queued for immediate eligibility; claiming it starts the next attempt.
   - Preserve the three-attempt ceiling: if an interrupted job already has 3 attempts, terminate it as failed instead of starting attempt 4. Use `"transient failure"` when its third attempt satisfies the simulated-failure condition; otherwise use a descriptive interruption error.
   - Leave existing queued retry deadlines and all terminal jobs untouched.
   - On graceful shutdown, stop claiming jobs, interrupt sleeps promptly, and leave any active job durably running for the same startup recovery path. Clear the heartbeat, stop timers, and close SQLite.
   - On `SIGKILL`, the last committed progress survives and the heartbeat naturally expires within 3 seconds.

7. **Build the browser page.**
   - Include every required `data-testid` exactly, with `form-error` carrying `role="alert"`.
   - Give numeric fields initial values `5` and `0`. Submit numeric values as JSON numbers; avoid converting an empty numeric field silently to zero—send an invalid value such as `null` so API validation rejects it.
   - Use `novalidate` on the form so API rejection messages can reach the required error region.
   - Clear the error region for each new submission; on rejection display the API message and every offending field’s name and message. Keep polling independent of form errors.
   - Fetch the list immediately on page load, after a successful submission, and approximately every 500 ms. Serialize list refreshes to avoid stale responses overwriting newer state.
   - Render one `job-item` with `data-job-id` per returned job, preserving the API’s newest-first order.
   - Render status, exact `completed/total` progress, and terminal result/error in the required descendants. Leave `job-result` empty for queued/running jobs.
   - Use DOM creation and `textContent` for submitted input, output, and errors; never interpolate user text into HTML.
   - Catch fetch failures and keep future polling active. Prevent duplicate in-flight form submissions without clearing the user’s values on rejection.

8. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the fixed checks with local HTTP, restart, and browser exercises below; the existing checks explicitly omit important durability and UI behavior.
   - Use temporary database paths and free ports. For crash tests, signal the actual Node process or its process group rather than only an npm wrapper.
   - Confirm the final source changes are limited to `src/` and `ui/`.

## Behaviours to verify
- **Startup and health:** Start each process first in separate runs against a missing database directory. Check readiness within 10 seconds, worker-up reporting, and worker-down within 3 seconds after killing the worker.
- **Response contracts:** Check initial queued defaults, exact job fields, null result/error, ISO timestamps, newest-first ordering, missing IDs, unknown routes, and wrong methods on every known route.
- **Validation:** Exercise malformed JSON, absent/wrong content type, primitives, arrays, null, whitespace input, lengths 1/1000/1001, Unicode JavaScript lengths, numeric strings, fractions, out-of-range values, explicit nulls, unknown fields, and multiple simultaneous errors. Confirm invalid requests create no rows.
- **Idempotency:** Replay omitted versus explicit defaults, change each normalized field, restart the server, and issue concurrent identical requests. Verify one ID and one row; requests without keys create distinct jobs.
- **Observable processing:** Submit a 20-step job and poll frequently. Confirm running status, incremental progress, roughly 100 ms steps, exact Unicode-aware JavaScript uppercase output, and one-at-a-time oldest-eligible processing.
- **Retries:** Exercise failAttempts 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3, then failure at attempt 3 for the remaining cases. Observe queued retry delays, zero failed-attempt progress, and no duplicate jobs.
- **Durability:** Stop/restart both processes with the same database. Kill a worker mid-job and during a retry delay. Verify terminal jobs stay unchanged, interrupted work recovers within the stated window, and idempotency persists.
- **Shutdown:** Send `SIGTERM` while idle and processing; verify both processes exit cleanly and restart without database corruption.
- **Browser:** Submit valid and invalid forms, verify numeric JSON types and all selectors, watch progress/status update within 2 seconds, inspect failed results, reload for durable history, and submit HTML-looking text to confirm safe rendering.

## Risks
- **Retry and crash accounting:** Do not decrement attempts, replay terminal jobs, or start a fourth attempt. The task does not specify the error for an interrupted third non-transient attempt; use the explicit terminal-interruption policy above.
- **SQLite contention:** Preserve busy-timeout-before-WAL ordering, initialize from either process, a
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
