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
Keep the existing TypeScript entry points, npm commands, and single HTML page. Use SQLite as the sole shared state for jobs, idempotency keys, retry scheduling, and worker health, with short transactions for every state transition. The server validates submissions and exposes the API; the worker processes one job at a time using asynchronous timers. The browser polls the API every 500 ms and renders the required elements.

## Files
- `src/db.ts`: Extend the existing database opener with shared, repeatable schema initialization; retain directory creation, busy timeout, and WAL.
- `src/jobs.ts`: Add job types, database row serialization, submission/idempotency transactions, queries, and worker state transitions.
- `src/validation.ts`: Add payload/header validation and normalized submission types.
- `src/server.ts`: Implement routing, JSON request handling, API errors, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, FIFO claiming, progress updates, transient retries, restart recovery, and shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, submission handler, and polling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Define the database schema and public serialization.**
   - Preserve `openDatabase()` and its defaults. Both entry points call the same initializer, allowing either process to start first.
   - Use `CREATE TABLE IF NOT EXISTS` for:
     - `jobs`: monotonically increasing integer sequence, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, and numeric `available_at` for retry scheduling.
     - Store a nullable, unique idempotency key on each job. SQLite permits multiple `NULL` keys.
     - `worker_health`: singleton row containing the last heartbeat time in epoch milliseconds.
   - Use the sequence for deterministic newest-first listing and oldest-first scheduling, including jobs created in the same millisecond.
   - Centralize conversion to the exact public job shape. Internal columns must not leak into responses. Return `result` only for completed jobs and `error` only for failed jobs.
   - Use prepared statements and bound parameters. Keep transactions synchronous and short; never hold a transaction over a timer or request-body read.

2. **Implement complete submission validation.**
   - Read the body as bytes, concatenate, then decode as UTF-8 and parse JSON; catch malformed JSON and stream errors.
   - Require the media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Missing or unsupported content type produces a `"body"` field error.
   - Reject `null`, arrays, and JSON primitives with a `"body"` error.
   - Enumerate all own keys and report every unknown field. Validate all known fields without stopping at the first error.
   - Require `input` to be a string of JavaScript length 1–1000 with `input.trim().length > 0`; store the original string unchanged.
   - Apply defaults only when `steps` or `failAttempts` is absent. Explicit `null`, strings, fractions, and out-of-range numbers are errors.
   - Validate a present `Idempotency-Key` against the exact specified regex, including rejecting an empty value. Report the header name exactly as `"Idempotency-Key"`.
   - Return `400 invalid_request` with a meaningful message and a `fields` array containing each offending field. Validate before consulting or changing idempotency state.

3. **Implement atomic creation and persistent idempotency.**
   - Use `BEGIN IMMEDIATE` around the key lookup and possible insert, with rollback on exceptions.
   - For an existing key, compare the stored input, steps, and fail-attempt count against the validated, defaulted payload. Return the existing job’s current representation with `200`, or `409 idempotency_conflict` for a difference.
   - Otherwise insert a job with `randomUUID()`, status `queued`, attempts/progress zero, null output/error, and matching creation/update timestamps.
   - Capture the inserted queued representation inside the transaction and return it with `201`; do not reread after commit, when the worker could already have claimed it.
   - Keep the unique database constraint as protection against concurrent submissions. Requests without a key always insert.
   - Never delete idempotency mappings when a job finishes or a process restarts.

4. **Complete HTTP routing and lifecycle.**
   - Match the URL pathname independently of the query string.
   - Known paths and methods:
     - `/`: `GET`, serving the existing HTML file via the existing module-relative path.
     - `/health`: `GET`.
     - `/api/jobs`: `GET` and `POST`.
     - `/api/jobs/:id`: `GET`, matching exactly one nonempty ID segment.
   - Recognize the route before checking its method. Unsupported methods on known paths return `405 method_not_allowed`; unknown paths return `404 not_found`.
   - Detail lookup returns `404 not_found` for an absent job. List returns `{ jobs: [...] }` ordered by descending sequence.
   - Use a common JSON response/error helper, including for unexpected request-handler failures. Catch asynchronous handler errors so malformed requests cannot crash the server.
   - Health is `up` only when the persisted heartbeat is no more than 3000 ms old; missing or stale heartbeats mean `down`.
   - Retain `PORT` default `3000`. On `SIGTERM`/`SIGINT`, stop accepting connections, finish active handlers, close the database, and exit. Bound connection draining so idle or incomplete requests cannot keep the process alive indefinitely.

5. **Implement the single-worker processing loop.**
   - Write a heartbeat immediately at startup and every 500 ms while idle, processing, or waiting for retries.
   - Poll for eligible work every 100 ms. Atomically select the oldest queued job whose `available_at <= Date.now()` and transition it to running.
   - A fresh attempt increments `attempts`, resets completed progress to zero, clears output/error, and updates `updatedAt`.
   - Wait approximately 100 ms for each step using asynchronous timers.
   - If the attempt number is at most `failAttempts`, fail after the first step’s delay, before recording any progress:
     - Attempts 1 and 2: return to `queued`, keep progress zero and error/result null, and persist `available_at = now + 500 ms`.
     - Attempt 3: set `failed`, attempts 3, error `"transient failure"`, and null result.
   - Otherwise persist completed progress after each step. On the final step, atomically set progress to `steps`, status to completed, and output to JavaScript `input.toUpperCase()`.
   - Update `updatedAt` for each state change. Completed and failed jobs never enter the claim query.
   - A delayed retry is ineligible until its persisted deadline; meanwhile the worker may process another eligible job.

6. **Make interrupted work recoverable and shutdown predictable.**
   - Under the task’s single-worker model, inspect persisted running work at worker startup before claiming new jobs. The server must never reset running jobs.
   - Recover an interrupted running attempt by restarting its step sequence at zero using its persisted attempt number. Treat this as recovery of the already-counted attempt, so a crash during attempt 3 cannot accidentally start attempt 4 or falsely fail an otherwise successful job.
   - Apply the same failure predicate and terminal transitions during recovery. Preserve queued retry deadlines across restarts.
   - With immediate recovery and 100 ms steps, recovery starts well inside the 10-second allowance.
   - On worker termination, stop claiming jobs, cancel or finish the current short timer, clear heartbeat scheduling, and close SQLite only after outstanding worker callbacks finish.
   - Leave interrupted running work durable for startup recovery; invalidate the heartbeat on graceful shutdown. After `SIGKILL`, heartbeat expiry reports the worker down.
   - Document the assumption of one worker process; supporting overlapping live workers would require ownership leases rather than unconditional startup recovery.

7. **Build the browser page and interaction.**
   - Add every required `data-testid` exactly as specified. Include associated labels, a textarea for input, numeric fields defaulting to 5 and 0, and an initially empty `form-error` with `role="alert"`.
   - Use `novalidate` so browser constraints do not suppress API validation and field errors.
   - On submission, clear the form error and send JSON. Convert numeric field values to numbers; represent blank/invalid numeric input as an invalid value such as `null` rather than silently converting a blank fail-attempt field to zero.
   - Disable submission while its request is pending and re-enable it afterward. On rejection, show the API message plus every field name and message. On success, clear the error and refresh the list.
   - Fetch the list on load and every 500 ms with nonoverlapping requests. Coordinate submission-triggered refreshes so an older response cannot overwrite a newer list.
   - Render newest first with one `job-item` carrying `data-job-id` per job. Render status, `completed/total`, and output/error in their required child elements.
   - Use DOM creation and `textContent` for all submitted input, result, and error text. Keep form values intact during list updates.
   - Catch polling/network errors and continue polling after recovery; use a separate connection message if needed so polling does not overwrite submission errors.

8. **Build and verify the finished implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The provided checks cover only examples; supplement them with the cases below using fresh temporary database paths and the browser.
   - Keep any committed supplemental verification source under `src/` if needed; do not modify the existing checks or configuration.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both together with a nonexistent database parent directory. Confirm readiness within 10 seconds and the configured port/path are respected.
- **Validation:** Submit malformed JSON, primitives, arrays, missing content type, unknown fields, whitespace-only input, explicit nulls, numeric strings, fractional/out-of-range values, and invalid keys. Combine several invalid fields and confirm all are named and the job count is unchanged.
- **String semantics:** Verify surrounding whitespace is preserved, JavaScript string-length boundaries are enforced, and Unicode output equals `input.toUpperCase()`.
- **Response contract and routing:** Inspect all job fields, JSON content types, missing IDs, unknown paths, and wrong methods on each known route.
- **Idempotency:** Compare omitted versus explicit defaults; send concurrent identical-key requests; reuse a key with different payloads; restart the server and replay again. Exactly one job must exist.
- **Ordering and progress:** Queue several jobs before starting the worker. Confirm FIFO processing, newest-first listing, pickup within one second when idle, and observable intermediate progress on a 20-step job.
- **Retries:** Check fail-attempt values 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0, 1, and 2; values 3–5 fail on attempt 3. Observe queued retry delays and no duplicate jobs.
- **Durability:** Terminate actual Node processes with both `SIGTERM` and `SIGKILL`, then restart against the same database. Check queued jobs, retry delays, running recovery, terminal state preservation, and idempotent replays. Specifically interrupt a successful third attempt and verify recovery.
- **Health and shutdown:** Observe worker up while idle and busy, down after graceful shutdown or within three seconds of its last heartbeat after abrupt death, and up after restart. Confirm bot
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
