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
Extend the existing TypeScript entry points using only Node.js built-ins. Put schema initialization, job serialization, and transactional state changes in a shared SQLite module that both processes can initialize independently. The server handles validation, durable idempotency, and the browser page; the worker processes one job at a time using short database transactions and asynchronous timers. Persist retry scheduling and worker heartbeat information so restarts do not depend on in-memory state.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactions, job serialization, and heartbeat storage.
- `src/jobs.ts`: Add shared job/payload types and submission validation.
- `src/server.ts`: Implement HTTP routing, request parsing, validation, idempotency, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, observable progress, retry scheduling, restart recovery, heartbeat updates, and graceful shutdown.
- `ui/index.html`: Build the submission form and polling job list with the required selectors.
- Leave all fixed files, commands, and files under `checks/` unchanged.

## Steps
1. **Define shared types and initialize SQLite from either process.**
   - Preserve directory creation and the existing `busy_timeout` before enabling WAL.
   - Use `CREATE TABLE IF NOT EXISTS` and short transactions so simultaneous startup works.
   - Store jobs with an internal increasing sequence, unique public UUID, status, original input, steps, fail-attempt limit, attempts, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, normalized payload fingerprint, and numeric retry-availability time.
   - Use the sequence for stable insertion ordering when timestamps tie: descending for listing and ascending for worker selection.
   - Store heartbeat time in a separate singleton table.
   - Centralize conversion from database rows to the exact public shape. Never expose internal scheduling, sequence, or idempotency fields. Return `progress.total = steps`, and explicitly include nullable `result` and `error`.
   - Use prepared statements and a transaction helper that always rolls back on failure. Never hold a transaction across an `await`.

2. **Implement complete submission validation.**
   - Read request chunks as buffers, concatenate, decode as UTF-8, and parse JSON with controlled error handling.
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types with field `body`.
   - Require a non-null, non-array object. Report malformed JSON and non-object bodies under `body`.
   - Collect all discoverable offending fields rather than returning at the first field error. Inspect own property names so unusual unknown keys are also rejected.
   - Require `input` to be a string with JavaScript length 1–1000 and nonempty `trim()`, but store the original string unchanged.
   - Apply defaults only when `steps` or `failAttempts` is absent. Require actual integer numbers in their respective ranges; reject null, strings, booleans, and fractions.
   - Validate a present `Idempotency-Key` against the exact required pattern, including rejecting empty or duplicate header values. Report its field name exactly.
   - Produce `{error:{code:"invalid_request",message,fields}}` and perform no database mutation on validation failures.
   - Compute the payload fingerprint from a fixed-order serialization of the validated input, steps, and failAttempts after applying defaults.

3. **Implement atomic creation and idempotency.**
   - For a validated submission, begin an immediate transaction.
   - If the supplied key already exists, compare its stored normalized payload. Return the original job’s current state with `200` for a match or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert a UUID-backed job with `queued`, attempts/progress zero, null output/error, and identical creation/update timestamps.
   - Read the new job inside the insertion transaction, commit, and return that captured queued representation with `201`. This prevents a fast worker from changing the creation response to `running`.
   - Enforce uniqueness in SQLite as well as in application logic. A missing key is stored as SQL null and never deduplicates submissions.

4. **Finish HTTP routing and shutdown.**
   - Route by parsed pathname, ignoring query strings.
   - Implement `GET /health`, `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/:id`, and `GET /`.
   - Health reads the persisted heartbeat and reports `up` only when its age is at most 3 seconds.
   - Match a job-detail route as exactly one path segment; handle malformed URI encoding without crashing.
   - Distinguish route recognition from method handling: recognized paths with unsupported methods return `405 method_not_allowed`; unknown paths and missing jobs return `404 not_found`.
   - Centralize JSON responses and structured errors. Preserve HTML content type for the page; use JSON content type for API and routing errors.
   - Catch asynchronous request-handler failures so malformed requests cannot cause unhandled rejections. Return a structured internal error for unexpected failures.
   - Retain the existing module-relative HTML lookup, which works from `dist/server.js`.
   - On SIGTERM/SIGINT, stop accepting connections, drain active handlers, and close SQLite afterward. Bound shutdown for stalled connections and avoid closing the database while handlers can still use it.

5. **Implement the worker state machine.**
   - Initialize SQLite and write a heartbeat immediately. Refresh it every approximately 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms when idle. Select the oldest queued job whose persisted availability time has arrived.
   - Atomically claim it by setting `running`, incrementing attempts, resetting progress to zero, clearing output/error, and updating its timestamp. Commit before waiting or processing.
   - Wait approximately 100 ms for every step using asynchronous timers.
   - At the first step, if the durable attempt number is at most `failAttempts`, fail before recording any progress.
   - For failures on attempts 1 or 2, atomically return the same job to `queued`, leave progress zero and public error/result null, and set availability to now plus 500 ms.
   - On the third simulated failure, atomically set `failed`, error `"transient failure"`, and null result.
   - On successful steps, persist progress and updatedAt separately after each delay. On the final step, atomically write full progress, `completed`, and `input.toUpperCase()` as output.
   - Delayed retries need not block other eligible jobs; among eligible jobs preserve oldest-first ordering.
   - Stop claiming work when shutdown begins. Finish or interrupt the current short wait, preserve recoverable durable state, clear heartbeat/timers, and close SQLite. Handle unexpected worker failures by exiting without falsely marking jobs completed.

6. **Make recovery explicit and durable.**
   - Assume the requested single worker process; only worker startup performs recovery. Starting or restarting the server must never reset running jobs.
   - On worker restart, recover any persisted running job before claiming fresh work and restart its steps from zero.
   - Treat this as continuation of the already-recorded interrupted attempt, retaining its attempt number; subsequent simulated-failure retries start new numbered attempts. This avoids exceeding three logical attempts or falsely failing a successful third attempt merely because the process died.
   - Keep the job running during that recovery, reset progress and update its timestamp transactionally, then apply the same step/failure logic.
   - Persist retry deadlines so a restart neither bypasses an unexpired delay nor adds an unnecessary full delay.
   - Never mutate completed or failed jobs during recovery. Keep recovery immediate so it meets the restart deadline.
   - Ensure the last progress update and successful completion are one transaction, preventing a durable half-completed final state.

7. **Build the browser page.**
   - Add labeled controls and all exact `data-testid` attributes from the task. Initialize numeric controls to 5 and 0.
   - Use a textarea for input and number controls for steps/failAttempts. Put `novalidate` on the form so API validation, including whitespace and range failures, remains observable.
   - Prevent normal navigation on submit. Send input unchanged and convert nonempty numeric values to numbers. Send an invalid value such as null for empty numeric controls rather than silently converting an empty string to zero.
   - Keep `form-error` present with `role="alert"`. Clear it when starting a submission and after success; on rejection display the API message and every field name/message.
   - Fetch jobs immediately and poll approximately every 300–500 ms. Serialize refreshes or discard stale responses so earlier requests cannot overwrite newer job state.
   - Refresh immediately after successful submission. Render jobs in API order, one `job-item` per job with `data-job-id`, and nested status, progress, and result elements.
   - Render submitted input, output, and errors using `textContent`, never interpolated HTML. Keep pending result elements empty.
   - Handle polling/network errors without stopping future refreshes or misrepresenting them as submission validation errors.

8. **Build and verify the completed implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The disclosed checks cover only basic startup, submission, selected validation cases, completion, one retry, and idempotency. Perform the additional checks below against isolated temporary databases without modifying `checks/`.
   - Review the final diff to confirm that only `src/` and `ui/` source files changed.

## Behaviours to verify
- **Independent startup:** Start the worker before the server, reverse the order, and start both simultaneously with a missing database parent directory. Both should become ready within 10 seconds.
- **Complete validation:** Submit malformed JSON, arrays, null, missing/wrong Content-Type, whitespace input, length boundaries, unknown keys, numeric strings, fractions, out-of-range values, and invalid keys. Combine several invalid fields and verify all are named and job count is unchanged.
- **Exact representation:** Inspect creation, running, retry-queued, completed, and failed responses through both detail and list endpoints. Check null fields, timestamps, original input preservation, and nested progress/result shapes.
- **Durable idempotency:** Replay omitted versus explicit defaults, change each payload field, issue concurrent identical-key requests, and repeat after restarting the server. Verify one job per key and new jobs for unkeyed submissions.
- **Processing and ordering:** Queue several jobs while the worker is stopped, start it, and poll frequently. Verify oldest-first pickup, sequential work, observable intermediate progress, and approximately 100 ms steps.
- **Retries:** Test failAttempts 0, 1, 2, 3, and 5. Expected terminal attempts are 1, 2, 3, 3, and 3; the last two fail with the exact required error. Observe queued retry delays and zero progress on simulated failures.
- **Unicode output:** Submit Unicode and surrounding whitespace; compare output to JavaScript `toUpperCase()` and length validation to JavaScript string length.
- **Crash durability:** Kill the worker during processing and during a retry delay, restart using the same database, and verify recovery, preserved job identity, and timely termination. Repeat with both processes killed and with a crash during the successful third attempt.
- **Terminal durability:** Restart both processes after completion/failure and verify 
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
