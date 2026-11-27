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
Use Node.js built-ins and the existing TypeScript entry points, with SQLite as the sole communication channel between the server and worker. Centralize schema initialization and job serialization so either process can start first and every endpoint returns the same representation. Keep database transactions short; persist progress, retry eligibility, and worker heartbeats between asynchronous waits. Serve a dependency-free browser page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend database initialization with the shared schema, indexes, and transaction helper; preserve directory creation, busy timeout, and WAL configuration.
- `src/jobs.ts` (new): Define job types, map database rows to API objects, and implement submission, lookup, listing, and worker state transitions.
- `src/validation.ts` (new): Validate request headers and parsed bodies; apply defaults and collect field errors.
- `src/server.ts`: Implement routing, JSON responses, request parsing, idempotent submission, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, heartbeat updates, durable retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Implement the required form, error region, job list, and polling using inline JavaScript and CSS.
- Leave all fixed files and `checks/` unchanged. Preserve existing commands and the compiled entry-point layout.

## Steps
1. **Create the shared SQLite schema.**
   - Retain `DatabaseSync`, recursive parent-directory creation, and `busy_timeout` before enabling WAL.
   - Run idempotent schema creation from `openDatabase()` in both processes.
   - Create a `jobs` table containing:
     - An integer insertion sequence for deterministic ordering.
     - A unique public ID generated with `randomUUID()`.
     - Input, steps, fail-attempt count, status, attempts, completed-step count, nullable output/error, and ISO creation/update timestamps.
     - Nullable unique idempotency key and nullable retry eligibility time in epoch milliseconds.
   - Store the normalized payload directly in the immutable input/steps/fail-attempt columns; these suffice for idempotency comparison.
   - Create a singleton worker-heartbeat table storing the last observed epoch-millisecond timestamp.
   - Index queued-job selection. Use prepared statements and a transaction helper that always rolls back on failure.
   - Map rows explicitly to the required public shape, excluding internal columns. Derive `progress.total` from `steps`; expose result only for completed jobs and error only for failed jobs.

2. **Implement validation before any submission writes.**
   - Require the media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`.
   - Read and parse the body, returning a `"body"` field error for malformed JSON, empty bodies, arrays, null, primitives, or invalid/missing content type.
   - Inspect own properties and report every unknown field.
   - Validate input as a string with JavaScript length 1–1000 and nonempty `trim()`, while preserving the original string.
   - Apply defaults only when fields are absent. Reject null, strings, fractions, and values outside the specified numeric ranges.
   - Validate a present `Idempotency-Key` against the exact supplied regex; report the header name in `fields`. Reject repeated header values rather than silently accepting one.
   - Aggregate all independently detectable errors, including header errors alongside body-field errors. Always include `fields` for `invalid_request`.

3. **Implement atomic creation and idempotent replay.**
   - After validation, start `BEGIN IMMEDIATE`.
   - If a key exists, read its original job and compare all three normalized payload values. Return that job with 200 for equality or `idempotency_conflict` with 409 otherwise.
   - Otherwise insert one queued job with attempts/progress zero, null result/error, and matching initial timestamps.
   - Read the new job inside the transaction, commit, then return that captured queued representation with 201. This prevents a fast worker from changing the creation response to running.
   - Enforce key uniqueness in SQLite as well as application logic. Requests without keys store SQL null and always create new jobs.

4. **Complete HTTP routing and lifecycle.**
   - Match pathname independently of method:
     - `/`: GET serves the existing HTML location.
     - `/health`: GET reports worker up only when its database heartbeat is at most 3 seconds old.
     - `/api/jobs`: GET lists jobs by insertion sequence descending; POST submits.
     - `/api/jobs/:id`: GET returns the job or `not_found`.
   - Return 405 with `method_not_allowed` for unsupported methods on these route shapes, including `/`; return 404 for unknown paths. An `Allow` header may accompany 405.
   - Centralize JSON success/error responses with `application/json`; HTML is the intentional exception.
   - Catch asynchronous request failures and avoid unhandled rejections or stack traces in API responses.
   - Preserve `PORT` and `DATABASE_PATH` defaults and the existing UI path relative to the compiled server.
   - On SIGTERM/SIGINT, stop accepting connections, finish or close outstanding requests within a bounded interval, then close SQLite. Ensure idle keep-alive connections do not prevent exit.

5. **Implement the worker state machine.**
   - Write a heartbeat immediately after startup and every 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms. Select the oldest eligible queued job, excluding future retry times.
   - Claim it in a short `BEGIN IMMEDIATE` transaction: set running, increment attempts, reset completed progress to zero, clear retry time/result/error, and update the timestamp.
   - Await 100 ms for each step without holding a transaction.
   - On the first step, if the persisted attempt number is at most `failAttempts`, fail before recording progress:
     - Attempts 1–2: persist queued status, progress zero, null result/error, and eligibility time `now + 500 ms`.
     - Attempt 3: persist failed status, progress zero, null result, and error exactly `"transient failure"`.
   - Otherwise persist progress after every step. For the final step, atomically store full progress, completed status, and `input.toUpperCase()`.
   - Process only one job at a time. During a retry delay, other eligible jobs may run; selection remains oldest-first among eligible jobs.
   - Update `updatedAt` on every job transition and progress write.

6. **Handle restarts and shutdown deliberately.**
   - On worker startup, recover a persisted running job before ordinary queued work.
   - Treat recovery as continuation of the interrupted durable attempt: reset progress to zero and execute that attempt again using its existing attempt number. Do not allocate a fourth attempt when the interrupted job was already on attempt 3.
   - Persist recovery’s reset and timestamp before processing. Apply the same transient-failure rule to the retained attempt number.
   - Preserve future retry eligibility across restarts. Never select completed or failed jobs.
   - On SIGTERM/SIGINT, stop claiming work and interrupt or finish the current short sleep. Leave unfinished processing durably running for startup recovery; do not lose its attempt count.
   - Clear heartbeat state after processing has stopped, clear timers, and close SQLite. After SIGKILL, the heartbeat naturally expires.
   - This design assumes the task’s single worker process; do not add a second worker that independently resets another live worker’s running job.

7. **Build the browser UI.**
   - Include every specified `data-testid`, with `form-error` carrying `role="alert"`.
   - Use defaults 5 and 0 for numeric controls. Submit input unchanged and convert nonblank numeric field values with `Number()`; send blank numeric fields as invalid values rather than silently applying client-side defaults.
   - Use `novalidate` so browser constraints do not prevent API validation errors from reaching the required error region.
   - On submit, clear the old error, prevent duplicate in-flight submissions, and POST JSON. Show the API rejection message plus every field name/message; clear the region after success.
   - Fetch the list initially, immediately after successful submission, and approximately every 500 ms. Serialize list refreshes to prevent older responses overwriting newer data.
   - Render one `job-item` per job in API order with `data-job-id`, status, exact `completed/total` progress, and output/error as specified.
   - Use DOM creation and `textContent` for submitted input and outputs. Keep polling failures separate from the form’s API rejection region and recover on subsequent polls.

8. **Build and verify the complete contract.**
   - During implementation, run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Use additional local API/browser checks for requirements omitted by the supplied suites; do not modify the fixed checks.
   - Use isolated temporary database paths and clean up processes after each lifecycle test.

## Behaviours to verify
- **Startup and configuration:** Start server-first, worker-first, and simultaneously with a nested database path. Confirm startup within 10 seconds and correct custom/default ports.
- **Validation:** Test missing/blank/oversized input, Unicode length boundaries, nulls, numeric strings, fractions, out-of-range values, unknown fields, malformed JSON, nonobjects, bad content types, and invalid keys. Combine several errors and confirm every offending field appears and the job count stays unchanged.
- **Job representation and routes:** Check every returned job’s shape, nullability, timestamps, newest-first ordering, missing-job 404, unknown-route 404, and known-route 405.
- **Idempotency:** Compare omitted defaults against explicit defaults; send simultaneous matching and conflicting submissions; restart the server and replay. Confirm exactly one original job per key and distinct jobs without keys.
- **Processing and progress:** Submit a 20-step job and poll rapidly. Observe running status and intermediate progress, approximately 100 ms steps, pickup within 1 second when idle, and exact JavaScript uppercase output.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify completion attempts 1/2/3 or terminal failure at 3, zero progress on simulated failures, queued retry delay between 250 ms and 2 seconds, and one job throughout.
- **Durability:** Kill the worker during ordinary processing, retry waiting, and the third attempt. Restart with the same database and verify recovery within the specified window. Restart both processes and confirm terminal jobs and idempotency records remain unchanged.
- **Heartbeat and shutdown:** Confirm worker up while processing/retrying, down within 3 seconds after SIGKILL, and clean SIGTERM exits without lingering timers or open database handles.
- **Browser:** Submit valid and invalid values, verify field names in the alert, inspect every required test ID, and observe progress/results within 2 seconds without reload. Test HTML-looking input to confirm safe text rendering.

## Risks
- **SQLite contention:** Keep transactions synchronous and brief; never hold locks across sleeps or request-body reads. Preserve the starter’s busy-timeout-before-WAL ordering.
- **Creation-response race:** Return the captured inserted row, not a fresh query after commit.
- **Recovery attempt ambiguity:** The task requires interrupted work to run again but does not explicitly say whether recovery consumes another attempt. Preserve the interrupted attempt as a continuation, especially at attempt 3, while counting every normal queued-to-running attempt.
- **Incorrect defaulting or coercion:** Apply defaults only to absent properties and validate API numbers without coercion.
- **Unstable ordering:** Use the insertion sequence 
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
