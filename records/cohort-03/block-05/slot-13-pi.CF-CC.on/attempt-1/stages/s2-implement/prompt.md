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
Use the existing TypeScript entry points, Node.js built-ins, and a shared SQLite database for jobs, retry scheduling, idempotency, and worker heartbeats. Keep database operations synchronous and transactions short; use asynchronous timers for processing so the HTTP server remains independent and progress stays observable. Implement the browser page in the existing HTML file with inline JavaScript and polling. Preserve all commands and fixed files.

## Files
- `src/db.ts`: Extend database initialization with schema creation, prepared queries, transactions, job serialization, and heartbeat helpers.
- `src/jobs.ts`: Add shared job types, submission validation, and payload normalization.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, durable progress, retries, recovery, heartbeat updates, and shutdown.
- `ui/index.html`: Build the submission form and live job list with all required test selectors.

## Steps
1. **Define the shared model and schema.**
   - Preserve `openDatabase()`’s directory creation and `busy_timeout` before WAL configuration. Both processes initialize the same schema using `CREATE TABLE IF NOT EXISTS`; either can start first.
   - Store jobs with an integer insertion sequence as primary key, a unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, retry eligibility time in milliseconds, and nullable unique idempotency key.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first selection, including jobs created within the same millisecond.
   - Add a singleton worker-heartbeat table with a timestamp. Initialize no fresh heartbeat from the server.
   - Centralize serialization into the exact public job shape. Hide internal sequence, retry time, and idempotency fields; derive `progress.total` from steps and wrap completed output in `{ output }`.
   - Use bound SQL parameters and a transaction helper that always rolls back on failure. Never hold a transaction across `await`.

2. **Implement complete submission validation.**
   - Read the complete request body as UTF-8 before parsing. Treat empty or malformed JSON, `null`, arrays, and primitive bodies as `"body"` errors.
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` error.
   - Validate every own property against the three allowed fields, collecting all independently detectable errors rather than stopping at the first.
   - Require `input` to be a string whose JavaScript length is 1–1000 and whose trimmed value is nonempty. Store its original value.
   - Apply defaults only when fields are absent. Explicit `null`, numeric strings, fractional numbers, and out-of-range values fail validation.
   - Validate a present idempotency header against the exact required expression, including rejecting an empty value or duplicate values. Report `"Idempotency-Key"` on failure.
   - Return one consistent `invalid_request` envelope with a required `fields` array. Validation must finish before any database mutation.

3. **Implement HTTP routing and durable idempotency.**
   - Route by pathname, ignoring query parameters. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment.
   - Check allowed methods for recognized routes before handling them; return JSON `405 method_not_allowed`, preferably with `Allow`. Unknown paths and missing jobs return JSON `404 not_found`.
   - Serve the existing HTML path relative to `import.meta.url`; it already resolves correctly from `dist/server.js`. Only the page response uses HTML content type.
   - Implement list/detail endpoints through the shared serializer.
   - For creation, normalize to the fixed tuple `[input, steps, failAttempts]`. Inside `BEGIN IMMEDIATE`, look up the idempotency key, compare those immutable columns, and either replay the current job, report a conflict, or insert a new UUID job.
   - Keep the unique database constraint as the final safeguard against duplicate keys. Unkeyed submissions always insert.
   - Return the inserted queued snapshot with `201` without rereading after commit, because the worker could already have claimed it. Replay returns `200`; conflict returns `409`.
   - Read health from the stored heartbeat: worker is up only when its heartbeat is at most 3 seconds old.
   - Catch asynchronous handler failures and return a JSON error envelope for unexpected failures without leaking internals.

4. **Implement the worker’s normal processing loop.**
   - Write a heartbeat immediately and refresh it every 500 ms, including while idle, processing steps, and waiting for retries.
   - Poll for work approximately every 100 ms. Within a short transaction, select the oldest eligible queued job and claim it by setting `running`, incrementing attempts, resetting progress, clearing output/error, and updating its timestamp.
   - Process one job at a time. Sleep 100 ms before each step; commit progress after every successful step.
   - On the last successful step, atomically set completed progress, `completed` status, and JavaScript `input.toUpperCase()` output. Do not use SQLite’s uppercase function.
   - For attempt number `n <= failAttempts`, fail after the first 100 ms delay and before recording progress.
   - If fewer than three attempts have started, atomically return the job to `queued` with eligibility `now + 500 ms`, zero progress, and null result/error. Otherwise set `failed`, error `"transient failure"`, and null result.
   - Keep retry eligibility in SQLite so restarts cannot erase the delay. While a retry is ineligible, the worker may process another eligible job, choosing the oldest eligible job each time.
   - Update `updatedAt` on every job transition and progress write.

5. **Handle recovery and clean shutdown.**
   - Under the specified single-worker model, recover existing `running` work before claiming ordinary queued work. Server startup must never recover worker state.
   - Restart interrupted processing from step zero. Treat recovery as replay of the unfinished logical attempt, retaining its persisted attempt number; this avoids decrementing attempts or creating a fourth logical attempt when a worker dies during attempt three. Actual transient failures still advance through the normal retry path.
   - Persist the reset before processing; completed and failed rows are never selected.
   - Keep recovery immediate, satisfying the restart deadline without waiting for the old heartbeat to expire.
   - On worker `SIGTERM`/`SIGINT`, stop claiming work, allow the current bounded attempt to finish, clear the heartbeat timer and heartbeat row, then close SQLite. An attempt lasts at most about two seconds; do not wait through a future retry delay.
   - Abrupt termination leaves committed running state for recovery and a heartbeat that naturally expires.
   - On server shutdown, stop accepting connections, drain active responses with a bounded deadline, close remaining connections if necessary, and close SQLite after request handlers can no longer access it.
   - Retain references to all timers and server handles so shutdown leaves no live handles.

6. **Build the browser page.**
   - Add the specified form, input fields, submit button, alert region, list, and per-job selectors verbatim.
   - Initialize numeric fields to 5 and 0. Use `novalidate` so browser constraints do not hide API rejection messages. Convert nonempty numeric field values with `Number`; send an empty numeric field as an invalid value rather than silently defaulting it.
   - POST all three field values as JSON. Disable the button while a submission is pending and restore it in `finally`.
   - Clear `form-error` before a new submission and after success. On API rejection, show the error message plus every offending field’s name and message.
   - Fetch the list immediately on page load and after successful submission; poll every 500 ms using a serialized refresh loop to prevent stale responses overwriting newer results.
   - Render API order unchanged, with one `job-item` and `data-job-id` per job. Render exact status, `completed/total`, and either completed output, failure error, or empty text.
   - Use DOM creation and `textContent` for submitted input and results. Keep polling/network messages separate from the submission-error region.

7. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The supplied checks start their own processes and databases.
   - Supplement those examples with local HTTP and process-lifecycle checks using Node built-ins and temporary databases. Do not modify `checks/` or fixed configuration files.
   - Inspect the browser page manually for submission errors, live progress, terminal output, ordering, and safe text rendering.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both together against a missing parent directory; verify readiness within 10 seconds and custom port/database handling.
- **Validation:** Submit malformed JSON, arrays, null, missing content type, empty/whitespace input, overlong strings, numeric strings, fractions, null numeric values, unknown fields, and invalid keys. Confirm all applicable field names and no inserted jobs.
- **Defaults and exact input:** Omitted numeric fields become 5 and 0; surrounding whitespace remains stored; Unicode output matches JavaScript `toUpperCase()`.
- **Routing:** Check wrong methods on every known route, missing IDs, unknown paths, and JSON content types/error envelopes.
- **Idempotency:** Send concurrent requests sharing a key; verify one `201`, replays with the same ID, defaults-equivalent replay, and `409` for changed payloads. Repeat after server restart.
- **Processing and timing:** Poll a 20-step job frequently to observe running state and intermediate progress. Confirm idle pickup within one second and terminal progress equals steps.
- **Retries:** Exercise `failAttempts` 0 through 5; expect completion on attempts 1, 2, and 3 for values 0–2, and failure at attempt 3 otherwise. Observe queued retry delays and null errors before terminal failure.
- **Durability:** Kill the worker during progress and during a retry delay, then restart against the same database. Also stop both processes and restart them. Confirm recovery, retained IDs, terminal rows unchanged, and persistent idempotency.
- **Liveness and shutdown:** Verify worker-up while idle and busy, worker-down within three seconds after `SIGKILL`, and clean bounded `SIGTERM` exits.
- **UI:** Verify every required selector, newest-first ordering, numeric JSON submissions, field-specific alert text, and progress/status refresh within two seconds.

## Risks
- SQLite startup and concurrent writes can contend: preserve busy timeout, initialize idempotently, and keep transactions short.
- A worker can claim a newly inserted job before the server responds: return the creation snapshot to guarantee `201` contains a queued job.
- Restart semantics do not explicitly define whether interrupted work consumes another attempt: consistently replay the unfinished logical attempt, preserving the three-attempt retry budget.
- Startup recovery assumes one worker process, as specified; do not reset running rows from the server or from an ordinary polling iteration.
- Native form validation, overlapping polls, or unsafe HTML insertion can break browser requirements: use API validation, serialized refreshes, and text-only rendering.
- The supplied checks omit restart, UI, and many validation cases; passing them alone is insufficient.

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
