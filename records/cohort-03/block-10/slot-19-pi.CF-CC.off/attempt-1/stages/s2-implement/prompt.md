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
Extend the existing TypeScript entry points using Node.js built-ins only. Put schema initialization, job persistence, and atomic state transitions in a shared SQLite module; the HTTP server and worker communicate exclusively through that database. Use short transactions, durable retry deadlines, and a worker heartbeat, with asynchronous timers between processing steps. Serve the browser page from the existing `ui/index.html` and poll the API for updates.

## Files
- `src/db.ts`: Extend `openDatabase`; initialize schema and add typed persistence helpers, transactions, and public job serialization.
- `src/jobs.ts`: Add shared job types, request validation, and normalized payload comparison.
- `src/server.ts`: Implement API routes, JSON errors, submission handling, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Add submission form, validation feedback, job rendering, and polling.
- Leave all fixed files, dependencies, commands, and `checks/` unchanged.

## Steps
1. **Establish the shared schema and database helpers.**
   - Preserve parent-directory creation, `DATABASE_PATH` default, and `busy_timeout` initialization before WAL configuration.
   - Initialize the same schema from both entry points using `CREATE TABLE IF NOT EXISTS`, so either process can start first. Use durable SQLite synchronization settings.
   - Store jobs with an internal insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, creation/update timestamps, nullable unique idempotency key, and retry eligibility time in epoch milliseconds.
   - Store heartbeat time in a singleton worker-state row. Only the worker updates it.
   - Index queue selection by status, eligibility, and creation order. Use insertion sequence to break timestamp ties deterministically.
   - Implement one serializer returning exactly the specified public shape; hide sequence, key, retry deadline, and other internal fields.
   - Generate timestamps with `new Date().toISOString()`. Update `updatedAt` on every job transition and progress write; preserve `createdAt`.
   - Use bound SQL parameters. Keep write transactions short and never hold one across an asynchronous delay.

2. **Implement complete request validation.**
   - Read request bytes and parse JSON once. Require media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`.
   - Require a non-null, non-array object. Malformed JSON, invalid media type, and non-object bodies produce a `"body"` field error.
   - Validate all supplied keys against the three allowed fields; collect every unknown or invalid field rather than returning on the first error.
   - Validate `input` with JavaScript `.length` and `.trim()` only for the whitespace check. Preserve the original string.
   - Default `steps` and `failAttempts` only when absent. Reject explicit `null`, strings, booleans, fractional values, and numbers outside the specified bounds.
   - Validate a present `Idempotency-Key` against the exact regex; an empty or duplicated header must not silently become an absent key. Include `"Idempotency-Key"` in field errors.
   - Return a normalized `{ input, steps, failAttempts }` only after validation succeeds. All validation failures use `400 invalid_request` with a populated `fields` array and create no database records.

3. **Make submission and idempotency atomic.**
   - Inside `BEGIN IMMEDIATE`, look up a supplied key and compare the stored input, steps, and fail-attempt count with the normalized payload.
   - Return the existing job’s current representation with `200` when all three values match; return `409 idempotency_conflict` otherwise.
   - If no existing key is found, insert one queued job with a UUID, attempts/progress zero, null result/error, and current timestamps. A nullable unique key permits unlimited unkeyed submissions.
   - Capture the newly inserted row inside the transaction and return that queued snapshot with `201`; do not reread it after commit, when the worker may already have claimed it.
   - Commit before responding and roll back on errors. The transaction and unique constraint must prevent duplicate creation under concurrent requests and across restarts.

4. **Implement HTTP routing and lifecycle.**
   - Preserve HTML loading relative to `import.meta.url`; the existing `../ui/index.html` location works from compiled `dist/server.js`.
   - Match pathname independently of query parameters:
     - `GET /`: serve HTML.
     - `GET /health`: return `status: "ok"` and `"up"` only when the stored worker heartbeat is at most 3 seconds old.
     - `POST /api/jobs`: validate and submit.
     - `GET /api/jobs`: serialize all jobs in descending insertion order.
     - `GET /api/jobs/:id`: return the job or `404 not_found`.
   - Recognize the route before checking methods. Wrong methods on known routes return `405 method_not_allowed`, preferably with `Allow`; unknown paths return `404 not_found`.
   - Centralize JSON responses and the required error envelope. Handle URL decoding and asynchronous request errors without crashing the process or leaving requests unanswered.
   - Retain the server handle. On `SIGTERM`/`SIGINT`, stop accepting connections, let active handlers finish, close idle connections, and close SQLite after requests drain. Bound shutdown for stalled connections.

5. **Implement worker scheduling and heartbeat.**
   - Initialize the database and write a heartbeat immediately. Refresh it about every 500 ms, including while processing jobs and waiting between retries.
   - Run one asynchronous processing loop. Poll about every 100 ms when idle.
   - Atomically select the oldest eligible queued job and claim it using a short transaction. Filter by the persisted retry deadline before ordering, so a delayed retry does not prevent other eligible jobs from running.
   - On a fresh attempt, set `running`, increment attempts, reset progress to zero, clear result/error, and update the timestamp.
   - Wait approximately 100 ms before each step using asynchronous timers. Persist each completed step separately so API readers observe intermediate progress.
   - On the final successful step, atomically set progress to `steps`, status to `completed`, and output to the exact input’s JavaScript `.toUpperCase()` result.
   - Restrict updates to the expected job state/attempt so stale work cannot overwrite a later transition.

6. **Implement transient retries and crash recovery.**
   - After the first step’s delay, before recording any progress, fail the attempt when its number is at most `failAttempts`.
   - For attempts 1 and 2, return the job to `queued`, keep progress at zero and result/error null, and persist a retry deadline approximately 500 ms ahead.
   - On the third transient failure, atomically set `failed`, attempts 3, result null, and error exactly `"transient failure"`.
   - Preserve retry deadlines across restarts; do not store retry scheduling solely in timers.
   - On worker startup, recover a persisted `running` job before accepting new queued work. Resume its already-recorded logical attempt by restarting its steps from zero, preserving its attempt number. This prevents repeated process crashes from consuming transient retries or exceeding the three-attempt budget; ordinary retries still increment attempts.
   - Recovery should begin immediately, without waiting for an old heartbeat to expire. This application has one worker process; do not add unnecessary multi-worker lease machinery.
   - Never recover or otherwise reprocess terminal jobs.
   - On `SIGTERM`/`SIGINT`, stop claiming jobs, interrupt or finish the current short timer, and leave interrupted work durably recoverable. Clear heartbeat/timers and close SQLite. `SIGKILL` must require no cleanup for recovery to work.

7. **Build the browser page.**
   - Add the exact required `data-testid` attributes, including `data-job-id` on each job item and `role="alert"` on `form-error`.
   - Use a textarea or text input for input, numeric controls defaulting to 5 and 0, and a submit button inside `job-form`.
   - Use `novalidate` on the form so browser constraints do not prevent the API’s rejection messages from being displayed.
   - Submit JSON with numeric conversions for numeric controls. Treat empty numeric values as invalid rather than silently defaulting them; preserve input text exactly.
   - Clear the error region on a new submission and after success. For rejected submissions, display the API message and every returned offending field’s name and message.
   - Fetch jobs initially, immediately after successful submission, and about every 500 ms thereafter. Prevent overlapping polling responses from replacing newer data with older snapshots.
   - Render in the API’s newest-first order. Show status, exact `completed/total` progress, completed output, or failed error as specified.
   - Use DOM construction and `textContent` for user-derived text. Keep the form independent of list updates so polling does not erase typing or focus.
   - Handle network failures without stopping subsequent polling or producing unhandled promise rejections.

8. **Build and verify the implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The supplied checks cover only startup and selected API examples. Perform the additional lifecycle, validation, concurrency, and browser checks below with a separate temporary database.
   - Keep any additional reusable test source under `src/` if added; do not modify fixed checks or configuration.

## Behaviours to verify
- **Independent startup:** Start the server alone and confirm health reports down; start the worker and confirm up within 10 seconds. Repeat worker-first with a missing database parent directory.
- **Validation:** Submit multiple invalid fields together, unknown keys, numeric strings, nulls, arrays, malformed JSON, whitespace-only input, and missing/non-JSON content type. Check each relevant field name and unchanged job count. Test input lengths 1, 1000, and 1001 using JavaScript string length.
- **Exact data preservation:** Submit leading/trailing whitespace and Unicode input; confirm stored input is unchanged and output matches JavaScript uppercase conversion.
- **Idempotency:** Replay omitted versus explicit defaults; send conflicting values; send concurrent requests with one key; restart the server and replay again. Verify one job and the correct `201`, `200`, and `409` responses.
- **Ordering and routes:** Create several jobs with the worker stopped; confirm newest-first listing and oldest-first processing after startup. Check missing IDs, unknown paths, and wrong methods for every known route.
- **Observable processing:** Poll a 20-step job frequently; observe running state and increasing progress, approximately 100 ms per step, final progress 20, and one result.
- **Retries:** Exercise `failAttempts` 0, 1, 2, 3, and 5. Confirm attempt counts 1, 2, 3, 3, and 3; queued retry waits within 250–2000 ms; zero failed-attempt progress; and exact terminal error.
- **Durability:** Stop/restart both processes with the same database. Repeat using `SIGKILL` during running work and during a retry wait. Confirm jobs survive, interrupted work completes within the recovery bound, retry eligibility persists, and terminal records remain unchanged.
- **Heartbeat and shutdown:** Kill the worker and confirm health becomes down after its last heartbeat expires. Send `SIGTERM` while idle and while busy; verify both processes exit promptly without open timers or database errors.
- **Browser contract:** Inspect every required test ID; submit valid and invalid forms; confirm numeric JSON values, field-specific alert text, newest-first rendering, live progress/status w
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
