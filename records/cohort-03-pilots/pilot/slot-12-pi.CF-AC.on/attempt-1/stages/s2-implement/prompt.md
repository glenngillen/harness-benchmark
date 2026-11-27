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
Use the existing Node HTTP server, a separate polling worker, and SQLite as the only communication and persistence mechanism. Centralize schema initialization, transactions, and job serialization so either process can start first. Persist retry deadlines and worker heartbeats, and commit each processing step separately so progress remains observable. Build the browser UI in the existing HTML file with inline JavaScript and periodic API polling; preserve all existing commands and fixed files.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactional submission and claiming, heartbeat storage, and job-state updates.
- `src/jobs.ts`: Add shared job/payload types, request validation, and the exact public job serializer.
- `src/server.ts`: Implement routing, JSON request handling, validation, idempotency, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, progress updates, retries, interrupted-job recovery, heartbeats, and graceful shutdown.
- `ui/index.html`: Implement the submission form, error region, job list, polling, and basic styling.
- Do not change configuration, dependency manifests, `TASK.md`, or `checks/`.

## Steps
1. **Define durable storage and public serialization.**
   - Preserve parent-directory creation and the existing `busy_timeout` before WAL configuration. Use `CREATE TABLE/INDEX IF NOT EXISTS` so simultaneous startup and either startup order work.
   - Store jobs with an insertion sequence (`INTEGER PRIMARY KEY`), unique public UUID, input, steps, fail-attempt setting, status, attempt count, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and retry eligibility time in epoch milliseconds.
   - Use the insertion sequence for deterministic oldest/newest ordering, including submissions created in the same millisecond.
   - Store worker heartbeat time in a separate singleton table. Schema initialization must not reset an existing heartbeat or job.
   - Serialize only the documented properties. Derive `progress.total` from `steps`; expose `result: {output}` only for completed jobs and `error` only for failed jobs. Keep database bookkeeping private.
   - Use bound parameters and short transactions with rollback on exceptions. Never keep a transaction open across an asynchronous sleep or request-body read.

2. **Implement comprehensive submission validation.**
   - Collect the request body as buffers, decode once, and parse JSON with controlled error handling.
   - Require the media type `application/json`, accepting case-insensitive spelling and parameters such as `charset=utf-8`.
   - Reject malformed JSON, empty bodies, arrays, `null`, and primitives using field `"body"`.
   - For an object, collect every unknown property and every invalid known field rather than stopping at the first error.
   - Validate `input` using JavaScript `.length` and `.trim()` for whitespace detection, but store its original value unchanged.
   - Apply defaults only to absent properties. Reject explicit `null`, numeric strings, booleans, fractions, and out-of-range numbers for numeric fields.
   - Validate a present `Idempotency-Key` against the exact requested expression, including rejecting an empty value. Include header errors alongside other errors that can be established.
   - Return `400` with `error.code: "invalid_request"`, a useful message, and `fields: [{field, message}, ...]`. Finish validation before any database write.

3. **Make job creation and idempotency atomic.**
   - Normalize the validated payload to `{input, steps, failAttempts}`.
   - In a `BEGIN IMMEDIATE` transaction, look up the supplied key. Compare the three normalized values directly against the original immutable submission values.
   - For an identical payload, return the original job’s current representation with `200`; for a mismatch, return `409 idempotency_conflict`.
   - Otherwise insert one queued job with a server-generated `randomUUID()`, attempts/progress zero, null output/error, and matching creation/update timestamps.
   - Enforce key uniqueness in SQLite as well as in application logic. Null keys permit unlimited independent submissions.
   - Capture the new job representation inside the transaction and return that snapshot with `201`. A worker may claim it immediately after commit, but the creation response must still describe the newly queued job.
   - Keep the key on the durable job row so replay survives server restarts.

4. **Complete HTTP routing and lifecycle.**
   - Identify the route from the URL pathname before checking its method.
   - Support `GET /`, `GET /health`, `GET/POST /api/jobs`, and `GET /api/jobs/:id`.
   - Return JSON `404 not_found` for unknown paths or missing job IDs. Return JSON `405 method_not_allowed` for unsupported methods on known route patterns, including `/` and `/health`; optionally include an `Allow` header.
   - List jobs by insertion sequence descending. Return the same serializer output from creation, replay, listing, and detail endpoints.
   - Report worker `"up"` only when a stored heartbeat is no more than 3 seconds old; absent or stale heartbeat means `"down"`. The server must never generate worker heartbeats.
   - Retain the existing HTML URL relative to `import.meta.url`; it resolves from both `src/server.ts` and compiled `dist/server.js`.
   - Catch asynchronous handler failures and return a JSON internal-error envelope when possible, without crashing the server or leaking database details.
   - On SIGTERM/SIGINT, stop accepting connections, allow active requests a bounded drain period, close remaining connections if necessary, and close SQLite after request handlers stop using it.

5. **Implement the worker state machine.**
   - Initialize SQLite independently and publish a heartbeat immediately, then approximately every 500 ms, including while idle, processing, and waiting for retries.
   - Poll approximately every 100 ms. Atomically select and claim the oldest queued job whose persisted retry deadline has elapsed.
   - Claiming changes status to running, increments attempts, resets progress to zero, clears output/error, and updates the timestamp. Process only one job at a time.
   - For each step, await approximately 100 ms. If the attempt number is at most `failAttempts`, fail on the first step before writing any progress.
   - Otherwise persist each completed step and timestamp. Commit the final step and completed state together, with output computed using JavaScript `input.toUpperCase()`.
   - On a simulated failure before attempt 3, return the same job to queued with progress zero, null output/error, and a durable eligibility deadline 500 ms later.
   - On the third simulated failure, persist failed status, attempts 3, progress zero, null output, and exactly `"transient failure"`.
   - Select only eligible queued work; retries retain their original creation order, while jobs waiting for their deadline do not prevent other eligible jobs from running.

6. **Recover interrupted processing and shut down predictably.**
   - The required deployment has one worker process. On worker startup, recover any persisted running job before claiming fresh queued work.
   - Treat recovery as continuation of the already-counted interrupted attempt: restart its steps from zero while preserving its attempt number. This avoids inventing a transient failure or a fourth attempt when a successful third attempt was interrupted.
   - Reapply the attempt’s failure rule and persist progress normally. With immediate recovery and 100 ms steps, an interrupted job can finish comfortably within the restart deadline.
   - Preserve retry deadlines across restarts and never select completed or failed jobs.
   - On SIGTERM/SIGINT, stop claiming work and exit the processing loop at a step boundary. Leave an interrupted job durably running for startup recovery, clear the heartbeat, stop timers, and close SQLite.
   - On SIGKILL, rely on committed SQLite state and heartbeat expiry; do not depend on shutdown callbacks for durability.

7. **Build the browser interface.**
   - Create the exact requested test IDs: `job-form`, `job-input`, `job-steps`, `job-fail-attempts`, `job-submit`, `form-error`, and `job-list`.
   - Default the numeric fields to 5 and 0. Use `novalidate` so browser validation does not conceal API rejection messages; avoid input limits that prevent testing server validation.
   - Submit input unchanged and convert nonempty numeric field values to numbers. Send an invalid value such as `null` for an empty numeric field rather than coercing it to zero or silently applying a default.
   - POST JSON without an idempotency key for ordinary form submissions. Disable the submit button only while its request is pending.
   - Clear `form-error` when beginning a new submission and after success. On rejection, show the API message and every `fields` entry, including its field name, in this `role="alert"` region.
   - Fetch jobs on page load, after successful submission, and approximately every 500 ms. Serialize refreshes or ignore stale responses so older responses cannot overwrite newer state.
   - Render one `job-item` per job with `data-job-id`, in API order. Include `job-status`, `job-progress` formatted exactly as `completed/total`, and `job-result` containing output, terminal error, or an empty string as appropriate.
   - Insert all submitted text, output, and errors with `textContent`, not HTML interpolation. Keep polling failures from erasing submission-validation messages, and resume polling after temporary failures.

8. **Build and verify the finished implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Use temporary databases and Node built-in HTTP/fetch scripts for the additional cases below. Do not modify fixed checks or introduce dependencies.
   - Inspect the browser page manually for form submission, errors, ordering, and live updates. Confirm the final source changes are confined to `src/` and `ui/`.

## Behaviours to verify
- **Startup and configuration:** Start either process first with a fresh nested `DATABASE_PATH`; then start both simultaneously. Confirm readiness within 10 seconds and correct custom/default ports.
- **Validation:** Exercise missing/blank/overlong input, emoji length boundaries, unknown fields, numeric strings, fractions, explicit nulls, arrays, malformed JSON, absent/wrong content type, and invalid keys. Check all offending field names and unchanged job count.
- **Defaults and exact input:** Submit only `input`; check defaults and preservation of surrounding whitespace. Verify Unicode output matches JavaScript uppercase behavior.
- **Routing:** Test wrong methods on every known route and unknown paths. Confirm status codes, error codes, and JSON content types.
- **Idempotency:** Replay omitted versus explicit defaults, replay after completion and restart, change each payload field, and issue concurrent requests with the same key. Confirm one ID and one row; no-key submissions create separate jobs.
- **Ordering and processing:** Queue multiple jobs before starting the worker. Check oldest-first processing, newest-first listing, pickup within one second, attempts/progress reset, and observable intermediate progress.
- **Retries:** Test `failAttempts` 0 through 5. Verify attempt counts 1, 2, or 3; queued retry delays; zero progress on failed attempts; exact terminal error; and no duplicate jobs/results.
- **Health:** Observe down without a worker, up while idle and busy, and down within roughly 3 seconds after SIGKILL.
- **Durability:** Restart both processes with the same database after graceful shutdown and SIGKILL. Check queued, waiting-retry, running, completed, and failed jobs. Interrupt a successful third attempt specifically; verify recovery without a fourth atte
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
