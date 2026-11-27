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
Implement the API and worker using Node.js built-ins, with SQLite as the sole shared state and communication channel. Extend the existing database helper so either process can initialize the schema independently, and use short transactions for submission, claiming, and recovery. Persist retry timing, attempt progress, and worker heartbeats; serve a self-contained browser page that polls the API. Preserve the current commands, TypeScript configuration, and `src/` → `dist/` layout.

## Files
- `src/db.ts`: Extend database initialization with schema, indexes, and transaction support; retain directory creation, busy timeout, and WAL.
- `src/jobs.ts`: Add job types, database row serialization, submission/idempotency operations, listing, lookup, and worker state transitions.
- `src/validation.ts`: Add request validation and normalized payload construction.
- `src/server.ts`: Replace the placeholder routes with the complete API, HTML serving, error handling, and shutdown handling.
- `src/worker.ts`: Replace the idle loop with heartbeat, recovery, sequential processing, retries, and shutdown.
- `ui/index.html`: Implement the submission form and live job list with all required selectors.
- Do not change fixed files or anything under `checks/`; add no dependencies.

## Steps
1. **Define the durable schema and shared representation.**
   - Keep `openDatabase()` defaults and parent-directory creation. Set `busy_timeout` before enabling WAL, as the starter already does. Use `synchronous=FULL` and idempotent schema creation in both processes.
   - Create a `jobs` table containing:
     - An integer insertion sequence for deterministic ordering and a unique string ID generated with `randomUUID()`.
     - `input`, `steps`, `fail_attempts`, `status`, `attempts`, `progress_completed`, nullable output and error, and ISO creation/update timestamps.
     - A nullable unique idempotency key and a canonical normalized payload string.
     - An integer `available_at` timestamp for retry eligibility.
   - Create a singleton worker-state table containing a heartbeat timestamp. Only the worker updates its liveness.
   - Index queued-job selection. Order jobs by insertion sequence descending for listing, ascending for processing.
   - Centralize serialization so every endpoint returns exactly the specified public shape. Derive `progress.total` from `steps`; expose `{output}` only when completed and an error only when failed. Never expose internal columns.
   - Provide a transaction helper using `BEGIN IMMEDIATE`, commit, and rollback. Do not hold transactions across asynchronous waits.

2. **Implement complete validation before any submission writes.**
   - Read the body as UTF-8 and parse JSON with explicit error handling. Require an `application/json` media type, case-insensitively, allowing parameters such as `charset=utf-8`.
   - Reject malformed JSON, arrays, null, primitives, and an empty body with a `"body"` field error. Missing or incorrect content type also uses `"body"`.
   - Inspect every own property and report all unknown field names, including names such as `__proto__`; use explicit allowlist membership.
   - Validate `input` using JavaScript `.length`, preserving its original value while using `.trim()` only to detect whitespace-only input.
   - Apply numeric defaults only when a property is absent. Reject null, strings, booleans, non-integers, and out-of-range values without coercion.
   - Validate the optional `Idempotency-Key` against the exact required expression. Reject empty, duplicate, or combined invalid header values and name `"Idempotency-Key"` in `fields`.
   - Accumulate all discoverable field errors, including header errors. Return `400 invalid_request` with a message and a `fields` array; never insert a job on invalid input.
   - Construct canonical JSON in fixed property order from the validated `{input, steps, failAttempts}` after applying defaults.

3. **Implement atomic creation and durable idempotency.**
   - Within one immediate transaction, look up a supplied key.
   - If found, compare its canonical payload: return the original job’s current state with `200` for equality, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert one queued job with attempts/progress zero, null output/error, and matching initial timestamps.
   - Keep a database uniqueness constraint on the key as the final protection against concurrent submissions. Handle any uniqueness race by reading and comparing the existing record.
   - Return the newly inserted queued snapshot with `201`. Capture that snapshot before committing so a fast worker cannot turn the creation response into a running job.
   - Without a key, always generate and insert a new job.

4. **Complete HTTP routing and process lifecycle.**
   - Route by URL pathname, independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment.
   - Support GET on `/`, `/health`, and individual jobs; support GET and POST on `/api/jobs`.
   - Resolve path recognition before method handling: unsupported methods on recognized paths return JSON `405 method_not_allowed`; unknown paths return JSON `404 not_found`. Missing job IDs return `404 not_found`.
   - Use a shared JSON response/error helper, including for unexpected failures. Catch asynchronous request-handler rejections and avoid sending twice after disconnection.
   - `/health` returns worker `"up"` only when the stored heartbeat is at most 3 seconds old; a missing or stale heartbeat means `"down"`.
   - Preserve loading `../ui/index.html` relative to `import.meta.url`, which works from `dist/server.js`. Serve it as HTML; all API responses and route errors use JSON.
   - Retain `PORT` and `DATABASE_PATH` behavior.
   - On SIGTERM/SIGINT, stop accepting connections, finish active handlers, close the database, and exit. Bound shutdown of stalled HTTP connections so keep-alive or incomplete requests cannot keep the process alive indefinitely.

5. **Implement sequential processing and persistent retry timing.**
   - Write a heartbeat immediately at startup and every approximately 500 ms, including while idle, processing, or waiting for retries.
   - Poll for eligible queued work every 100 ms. Claim the oldest eligible job atomically in a short transaction, setting `running`, incrementing `attempts`, resetting progress, clearing result/error, and updating `updatedAt`.
   - Process only one job at a time. Await approximately 100 ms for each step, then persist progress in a short write.
   - At the first step, before advancing progress, check whether the current attempt number is at most `failAttempts`.
   - For a simulated failure before attempt 3, persist `queued`, progress zero, null result/error, and `available_at = now + 500 ms`. Preserve the ID, input, and attempt count.
   - A delayed retry is ineligible until its persisted timestamp; other eligible queued jobs may proceed. Among eligible jobs, always choose the oldest.
   - On the third simulated failure, atomically persist `failed`, error exactly `"transient failure"`, null result, and attempts 3.
   - On success, atomically persist the final progress and `completed` state with output from JavaScript `input.toUpperCase()`. Do not use SQLite’s `upper()`, whose Unicode behavior differs.
   - Update `updatedAt` on each job transition or progress change; heartbeat writes must not alter job timestamps.

6. **Recover interrupted work and shut down safely.**
   - For the required single-worker deployment, inspect unfinished `running` rows at worker startup before accepting fresh work. Never perform worker recovery from server startup.
   - Replay an interrupted durable attempt from progress zero, preserving its attempt number: it is continuation of an unfinished attempt, not a simulated failure or an extra retry. This also lets an interrupted third attempt finish without inventing a fourth retry or falsely failing successful work.
   - Process recovered work before ordinary queued work; terminal rows are excluded from all processing queries. Preserve queued retry deadlines across restarts.
   - Make recovery initialization atomic. After a crash at any transition, the persisted status determines whether to recover an unfinished attempt, wait for a retry, or leave a terminal job untouched.
   - On SIGTERM/SIGINT, set a stopping flag and stop claiming work. Check it after each short sleep and before subsequent writes; leave any unfinished attempt durably recoverable.
   - Clear heartbeat timers, clear the worker heartbeat on graceful exit, and close SQLite only after the processing loop has stopped. SIGKILL is handled by heartbeat expiry and startup recovery.

7. **Build the browser page.**
   - Add labeled fields and a submit button inside `data-testid="job-form"` with the exact required test IDs. Initialize steps to 5 and failAttempts to 0.
   - Add an always-present, initially empty `data-testid="form-error"` region with `role="alert"`.
   - Use `novalidate` so browser constraints do not suppress API validation. Send the input unchanged and numeric values as numbers. Handle blank/non-finite numeric entries explicitly as invalid values, such as null, rather than silently applying defaults.
   - POST JSON on submit. Clear previous rejection text for a new submission; display the API error message plus every field name and field message on rejection. Clear the region after success and refresh the list immediately.
   - Fetch the initial list and poll approximately every 500 ms. Serialize refreshes or discard stale responses so overlapping requests cannot revert newer states.
   - Render jobs in API order under `job-list`, one `job-item` per job carrying `data-job-id`.
   - Inside each item render exact status, progress as `completed/total`, and output/error/empty text according to state.
   - Use DOM creation and `textContent` for submitted text and output. Do not interpolate user-controlled text into HTML.
   - Keep polling errors separate from submission validation errors, preserve form input during refreshes, and prevent duplicate in-flight form submissions.

## Behaviours to verify
- **Existing commands:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The supplied checks cover only part of the task.
- **Independent startup:** With a temporary database in a missing parent directory, start server first, worker first, and both together. Confirm readiness within 10 seconds and no SQLite initialization races.
- **Health:** Observe `"down"` without a worker, `"up"` after startup, and `"down"` within approximately 3 seconds after SIGKILL. Confirm it stays up during long jobs and retry delays.
- **Validation:** Exercise all boundaries, omitted defaults, explicit nulls, numeric strings, fractions, unknown fields, several invalid fields together, malformed JSON, non-object bodies, content types, and invalid keys. Verify no job was created.
- **Representation and ordering:** Check all public fields for queued, running, retrying, completed, and failed jobs. Submit a rapid burst and confirm deterministic newest-first listing.
- **Idempotency:** Send concurrent identical requests with one key; expect one creation and identical IDs. Replay omitted versus explicit defaults, change each payload field, and repeat after server restart. No-key duplicates must create distinct jobs.
- **Timing and retries:** Poll a 20-step job frequently enough to observe running progress. Check pickup within 1 second, roughly 100 ms steps, queued retry delays, success on attempts 1/2/3 for `failAttempts` 0/1/2, and terminal failure at attempt 3 for values 3–5.
- **Durability:** Kill and restart processes with the same database during running work and retry waits. Check recovery within the specified bound, including interruption during attempt 3. Confirm completed/failed jobs, results, and idempotency mappings remain unchanged.
- **Shutdown:*
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
