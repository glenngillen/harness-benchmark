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
Use the existing Node.js HTTP server and worker entry points, with SQLite as the sole communication and persistence layer. Centralize schema initialization, job serialization, and transactional state changes so either process can start first. The worker will poll for eligible jobs, persist progress after each timed step, and publish a heartbeat independently of processing. The browser page will submit through the API and poll for updates without dependencies.

## Files
- `src/db.ts`: Extend database initialization with durable schema, indexes, shared job types/serialization, and transactional persistence helpers.
- `src/validation.ts`: Add request validation and normalized submission types.
- `src/server.ts`: Implement API routing, JSON errors, idempotent submissions, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement FIFO processing, progress, delayed retries, restart recovery, heartbeat, and shutdown.
- `ui/index.html`: Implement the submission form, accessible error region, job list, and polling script.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Define the database schema and public representation.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL initialization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both entry points. Use durable SQLite synchronization, such as `PRAGMA synchronous = FULL`.
   - Store jobs with an internal integer sequence primary key, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, retry eligibility time, and nullable unique idempotency key.
   - Generate public IDs with `randomUUID()` from `node:crypto`.
   - Use the insertion sequence for deterministic ordering, including jobs created in the same millisecond. Index queued-job selection.
   - Add a singleton worker heartbeat table containing the last heartbeat epoch time.
   - Provide one serializer that exposes exactly the specified job properties, constructs `progress`, and returns `result` only for completed jobs and `error` only for failed jobs. Keep scheduling and idempotency columns private.
   - Use prepared statements and short synchronous transactions with rollback on exceptions. Never hold a transaction across a timer or request-body read.

2. **Implement validation before any submission mutation.**
   - Read the complete request body and parse JSON inside controlled error handling; handle aborted/erroring request streams without crashing the server.
   - Require media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`.
   - Require a non-null, non-array object. Use `body` for malformed JSON, invalid body shape, and missing/incorrect content type.
   - Enumerate unknown own properties and validate all known fields, accumulating each offending field rather than stopping at the first.
   - Check `input` with JavaScript `.length`, requiring 1–1000 code units and nonempty `.trim()`, while storing its original value.
   - Apply defaults only to absent numeric fields. Reject null, booleans, numeric strings, fractions, and out-of-range values with `Number.isInteger` and explicit type checks.
   - Validate an explicitly supplied `Idempotency-Key` against the exact regex, including rejection of an empty value. Report its field name exactly as specified.
   - Every validation response includes `error.code`, a useful message, and `fields`; invalid submissions never reach insertion.

3. **Implement atomic submission and idempotency.**
   - Normalize successful validation to `{ input, steps, failAttempts }`.
   - Within `BEGIN IMMEDIATE`, look up the supplied key. Compare all three normalized values directly with the stored original submission.
   - Return the current original job with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert one queued job with attempts/progress zero, null output/error, and equal creation/update timestamps; commit before responding.
   - Return the inserted queued snapshot with `201`, rather than rereading after commit when the worker may already have claimed it.
   - Keep the database uniqueness constraint as the final protection against duplicate keyed submissions. Without a key, always insert.
   - Persist keys with jobs so replay and conflict behavior survive server restarts.

4. **Complete routing and server lifecycle.**
   - Match the URL pathname independently of query parameters.
   - Recognize `/`, `/health`, `/api/jobs`, and exactly one ID segment under `/api/jobs/`.
   - Dispatch allowed methods explicitly: GET for `/`, `/health`, and individual jobs; GET and POST for `/api/jobs`.
   - Return `405 method_not_allowed` for recognized routes with unsupported methods, optionally including `Allow`. Unknown paths and missing jobs return `404 not_found`.
   - Return all API successes and errors with `application/json`; serve `/` as HTML.
   - List jobs by descending insertion sequence; fetch individual jobs using bound parameters.
   - Read heartbeat state on each health request; report up only when its age is at most 3000 ms. A missing heartbeat means down.
   - Preserve the existing module-relative HTML path, which works from `dist/server.js` without copying UI files.
   - Catch unexpected request failures and return a structured JSON server error where possible.
   - On SIGTERM/SIGINT, stop accepting connections, finish or bound outstanding requests, then close SQLite. Avoid leaving keep-alive or partial-body connections hanging indefinitely.

5. **Implement the worker state machine.**
   - Initialize the database, recover interrupted running jobs, publish an immediate heartbeat, and start a heartbeat timer at roughly 500 ms.
   - Poll for work every 100 ms. Select the oldest queued job whose persisted retry eligibility time has arrived; waiting retries must not block other eligible jobs.
   - Claim inside a short write transaction: set running, increment attempts, reset completed steps, clear output/error, and update the timestamp. Process one claimed job at a time.
   - For each step, await roughly 100 ms with an asynchronous timer.
   - On the first step, if the attempt number is at most `failAttempts`, record no progress:
     - Before attempt 3, return the job to queued with eligibility approximately 500 ms later and null public error/result.
     - At the third failed attempt, mark failed with `"transient failure"`, null result, and attempts 3.
   - Otherwise persist each completed step. On the final step, atomically persist full progress, completed status, and the JavaScript `input.toUpperCase()` output.
   - Update `updatedAt` on every job transition/progress change; never change `createdAt`.
   - Keep the heartbeat running during step waits and retry waits. Do not block the event loop with processing sleeps.

6. **Handle interruption and restart explicitly.**
   - Under the specified single-worker deployment, recover leftover running rows at worker startup; the server must never perform worker recovery.
   - Preserve durable input, attempt count, and job identity. Reset progress when beginning replacement processing, and never touch completed or failed rows.
   - Persist retry deadlines so restarting does not discard scheduled retry delays.
   - For an interrupted attempt below the attempt limit, requeue it immediately; the next claim starts and counts a new attempt.
   - Handle an interrupted third attempt explicitly without starting attempt 4: replay that interrupted attempt from progress zero using its existing attempt number, applying the same simulated-failure rule. This allows crash recovery without exceeding the three-attempt budget; document this recovery interpretation in the worker code.
   - On SIGTERM, stop claiming new work, finish the current short step and exit without completing the rest of the job. Leave unfinished running state recoverable, clear the heartbeat, stop timers, and close the database.
   - SIGKILL requires no special handler: committed state survives, the heartbeat expires, and startup recovery handles running jobs.

7. **Build the browser page.**
   - Include every required `data-testid`, with one `job-item` carrying `data-job-id` per job inside `job-list`.
   - Provide input, steps, and fail-attempt fields; initialize numeric fields to 5 and 0.
   - Use `novalidate` so browser constraints do not prevent API validation errors from reaching the required alert region.
   - Submit raw input text and explicitly converted numeric values. Treat blank numeric values as invalid values rather than accidentally converting a blank fail-attempt field to valid zero.
   - Keep `form-error` present with `role="alert"` and empty initially. Clear it on a new submission; on rejection display the API message and every returned field name/message.
   - Fetch jobs on page load, immediately after successful submission, and approximately every 500 ms using a non-overlapping polling loop.
   - Render status, exact `completed/total` progress, and output/error according to status, preserving newest-first ordering.
   - Use DOM creation and `textContent` for user input, results, and errors to prevent HTML injection. Polling must not reset form fields or erase submission errors.
   - Handle fetch failures and resume polling automatically.

8. **Build and verify in the implementation session.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Resolve strict TypeScript and `node:sqlite` row-typing issues without changing compiler configuration.
   - Supplement the disclosed checks with temporary local HTTP/process probes and browser inspection; do not modify `checks/` or add dependencies.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate trials with the same fresh nested `DATABASE_PATH`; confirm startup within 10 seconds, configured port, and automatic directory creation.
- **Public representation:** Check initial, running, retrying, completed, and failed snapshots for every required property, ISO timestamps, nullability, and stable IDs.
- **Validation:** Submit malformed JSON, arrays/null/scalars, missing content type, whitespace-only input, oversized input, numeric strings, fractions, null fields, multiple invalid fields, unknown fields, and malformed keys. Confirm named errors and unchanged job count.
- **Defaults and Unicode:** Omit numeric fields and verify defaults; use whitespace-surrounded and non-ASCII input to verify exact storage and JavaScript uppercase behavior.
- **Idempotency:** Replay omitted versus explicit defaults, changed field ordering, and changed payloads. Send concurrent requests using one key and repeat after server restart; verify exactly one job. Unkeyed repeats must create separate jobs.
- **Routes:** Exercise missing IDs, unknown paths, query strings, and wrong methods on each known path; verify status codes and JSON content types.
- **Timing and progress:** Poll a 20-step job frequently and observe intermediate progress, monotonic counts within an attempt, timely pickup, and final full progress.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5; expect completion on attempts 1, 2, and 3, then terminal failure at 3 for the last two cases. Observe zero-progress queued retry intervals and no duplicate jobs.
- **Ordering:** Queue several jobs with the worker stopped; start it and verify oldest-first processing and newest-first API/UI listing.
- **Health:** Confirm up while idle and processing, down after graceful shutdown, and down within three seconds after the last heartbeat following SIGKILL.
- **Durability:** Stop/restart both processes against the same database using SIGTERM and SIGKILL. Verify queued jobs, retry delays, keys, and terminal jobs persist; kill during visible progress and confirm recov
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
