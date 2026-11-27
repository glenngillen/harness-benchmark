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
Keep the existing TypeScript entry points, npm commands, and single HTML page. Use `node:sqlite` for all persistent job state, retry scheduling, idempotency, and worker heartbeats; both processes initialize the same schema independently. The server handles validation and HTTP requests, while a sequential worker performs timed steps and commits each state transition. Use short transactions, asynchronous timers, and browser polling to keep progress observable and shutdown responsive.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, typed row mapping, and transactional job operations.
- `src/jobs.ts` (new): Define job and submission types, request validation, normalized payload comparison, and public job serialization.
- `src/server.ts`: Replace the placeholder routes with the HTTP API, HTML serving, error handling, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat updates, oldest-first claiming, timed processing, retries, restart recovery, and shutdown.
- `ui/index.html`: Add the submission form, accessible errors, job list, polling, and minimal styling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Establish the shared database schema.**
   - Preserve parent-directory creation, `DATABASE_PATH` default, and the existing ordering of `PRAGMA busy_timeout = 5000` before enabling WAL.
   - Initialize tables and indexes with `IF NOT EXISTS` from both entry points. Keep initialization transactions short so simultaneous startup works.
   - Store jobs with an internal integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, and an epoch-millisecond `available_at` for delayed retries.
   - Store a nullable unique idempotency key on each job. Immutable input/steps/fail-attempt columns provide the normalized payload for comparison; multiple `NULL` keys must be allowed.
   - Add a singleton worker heartbeat row containing its last-seen epoch milliseconds.
   - Use insertion sequence for deterministic newest-first listing and oldest-first claiming, including submissions with identical timestamps.
   - Centralize serialization so every endpoint returns exactly the specified public fields. Never expose scheduling or database metadata. Construct `progress.total` from `steps`, and expose result/error only for their corresponding terminal status.

2. **Implement complete submission validation before any database mutation.**
   - Read the request body asynchronously and parse JSON with controlled error handling.
   - Accept the media type `application/json`, case-insensitively, including parameters such as `charset=utf-8`; reject missing or different content types with a `"body"` field error.
   - Require a non-null, non-array JSON object. Malformed JSON and invalid root values produce `"body"` errors.
   - Inspect all own keys and collect unknown-field errors alongside errors for every invalid known field.
   - Require a string input with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Store the original string without trimming.
   - Apply defaults only when optional properties are absent. Explicit `null`, strings, booleans, fractional numbers, and out-of-range values remain invalid.
   - Validate the optional idempotency header against `^[A-Za-z0-9_-]{1,128}$`; reject empty or ambiguous duplicate values and name `"Idempotency-Key"` in errors.
   - Return `400` with `error.code = "invalid_request"`, a useful message, and an array of `{field, message}` entries. Collect independent header errors even when body validation fails.

3. **Implement transactional creation and idempotency.**
   - Use a short `BEGIN IMMEDIATE` transaction for lookup, comparison, and insertion; rollback on exceptions.
   - For an existing key, compare exact input and defaulted numeric values. Return its current job representation with `200` when equal, or `409 idempotency_conflict` when different.
   - For a new submission, assign `crypto.randomUUID()`, set queued status, attempts/progress to zero, null output/error, and equal initial timestamps; insert and commit before responding `201`.
   - Capture the inserted queued representation inside the transaction. Do not reread after commit for the creation response, since the worker could already have claimed the job.
   - Enforce uniqueness in SQLite as well as in application logic. Invalid submissions and conflicts must neither create jobs nor reserve keys.

4. **Implement the HTTP route contract.**
   - Match pathname independently of method, then apply the allowed methods:
     - `/`: GET serves the existing HTML location using `new URL('../ui/index.html', import.meta.url)`, which also works from `dist/server.js`.
     - `/health`: GET reads the heartbeat and returns `"up"` only when it exists and is no more than 3000 ms old.
     - `/api/jobs`: GET lists all jobs newest first; POST uses the validated transactional submission flow.
     - `/api/jobs/:id`: GET returns the job or `404 not_found`.
   - Return `405 method_not_allowed` for unsupported methods on recognized paths, including a job detail path whose ID does not exist. Optionally include `Allow`.
   - Return `404 not_found` for other paths. Avoid accidentally recognizing paths with extra segments.
   - Use one JSON response helper for all API responses and errors. Catch asynchronous handler failures and return a structured `500` without leaking database details; log operational failures.
   - Keep the configured/default port and existing startup command working.

5. **Implement worker scheduling and processing.**
   - Write a heartbeat immediately after initialization and refresh it about every 500 ms, including during idle periods, step delays, and retry waits.
   - Poll for work every 100 ms. In a short transaction, select the oldest queued job whose `available_at <= now`, mark it running, increment attempts, reset progress to zero, clear output/error, and update its timestamp.
   - Process one job at a time. Never hold a transaction across a timer.
   - Before each step finishes, await approximately 100 ms using asynchronous timers.
   - If the current attempt number is at most `failAttempts`, fail after the first step delay but before recording any progress:
     - Attempts 1–2: atomically return the same job to queued, leave progress zero and result/error null, and set `available_at = now + 500 ms`.
     - Attempt 3: atomically mark failed, set error to `"transient failure"`, and leave result null.
   - Otherwise, commit each finished step and update `updatedAt`. On the final step, atomically set completed status, full progress, and output computed by JavaScript `input.toUpperCase()`.
   - During a retry delay, other eligible jobs may run. Among eligible jobs, retain original insertion order.
   - Never select completed or failed jobs.

6. **Handle recovery and shutdown explicitly.**
   - The task requires one worker process. On worker startup, recover any persisted running job before claiming queued jobs; the server must never perform worker recovery.
   - Treat crash recovery as continuation of the already-counted, interrupted attempt: keep `attempts`, reset its progress to zero, and replay that attempt from the first step. This avoids inventing a transient failure or exceeding three attempts when a worker dies during attempt 3.
   - Apply the same failure predicate to the recovered attempt. Subsequent genuine retries increment attempts normally.
   - Preserve queued retry deadlines across restarts. A fresh worker should begin recovery immediately, well within the required ten seconds.
   - On worker `SIGTERM`/`SIGINT`, stop taking work, interrupt or finish the current short timer, and leave an unfinished job running for recovery. Clear heartbeat timers, invalidate the heartbeat, close SQLite, and exit without pending timers.
   - On server shutdown, stop accepting requests, allow active handlers to finish, then close SQLite. Use bounded connection cleanup so a stalled client cannot prevent exit.
   - After `SIGKILL`, rely on committed SQLite state and heartbeat expiry; no cleanup handler is assumed to run.

7. **Build the browser page.**
   - Add a form with all required test IDs, labeled input/steps/fail-attempt fields, defaults `5` and `0`, and a submit button.
   - Use `novalidate` so browser constraints do not suppress API validation. Convert numeric field values using `Number` without truncation; send blank numeric values as `null` so invalid entries are not silently defaulted or converted to zero.
   - POST JSON to `/api/jobs`. Clear `form-error` before a submission and after success. On rejection, show the API message plus every offending field name and its message in the `role="alert"` region.
   - Render the job list newest first, with one `job-item` carrying `data-job-id` per job. Include exact status text, `completed/total`, and output/error/empty result text according to status.
   - Use DOM APIs and `textContent` for submitted text, results, and errors.
   - Fetch the list on load, after successful submission, and approximately every 500 ms. Serialize refreshes or discard stale responses so older polls cannot overwrite newer state.
   - Keep polling after transient network errors without overwriting form validation messages. Polling must not replace the form or disturb entered values.

8. **Build and verify without changing fixed files.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The supplied checks cover only basic startup, submission, selected validation, completion, one retry, and idempotency. Supplement them with temporary local scripts using Node built-ins and manual browser checks.
   - Use isolated temporary databases and ports for supplementary checks; test both process startup orders and simultaneous startup.

## Behaviours to verify
- **Public job shape:** Submit with the worker stopped; inspect `201`, detail, and list responses for queued status, defaults, zero attempts/progress, null result/error, ISO timestamps, and no internal fields.
- **Validation:** Exercise malformed/empty JSON, primitive/array/null roots, missing/non-JSON content types, numeric strings, null optional values, numeric bounds/fractions, whitespace-only input, long input, multiple unknown fields, and invalid keys. Assert every relevant field is named and job count stays unchanged.
- **Exact text handling:** Submit padded text and Unicode text; confirm stored input is unchanged, length follows JavaScript semantics, and output matches JavaScript uppercasing.
- **Routing:** Check every known path with unsupported methods, unknown paths, and missing IDs; verify status, JSON content type, and error code.
- **Idempotency:** Replay omitted versus explicit defaults, vary property order, change each payload field, send concurrent same-key requests, and restart the server. Assert one persistent job per key and distinct jobs without keys.
- **Ordering and timing:** Queue multiple jobs before starting the worker; observe oldest-first processing and newest-first listing. Poll a 20-step job frequently to observe incremental progress and pickup within one second.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify attempt totals 1, 2, 3, 3, and 3, appropriate terminal states, zero failed-attempt progress, a visible delayed queued state, and no duplicate jobs.
- **Health:** Check server-only `"down"`, startup `"up"`, continued `"up"` during long jobs/retries, and `"down"` within three seconds after killing the worker.
- **Durability:** Restart both processes using the same database after graceful stops and `SIGKILL`. Preserve terminal jobs and idempotency keys; recover a running long job, including one interrupted on attempt 3, and preserve delayed retries.
- **Shutdown/startup:** Verify startup under ten seconds wi
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
