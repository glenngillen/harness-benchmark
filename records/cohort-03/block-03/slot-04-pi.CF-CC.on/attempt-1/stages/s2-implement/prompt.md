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
Keep the existing TypeScript entry points and commands, using Node.js built-ins exclusively. Put schema initialization, persistence operations, and job serialization in shared modules so the HTTP server and worker can start independently against the same SQLite file. Use short database transactions for creation, idempotency, and worker state changes; never hold a transaction across a processing delay. Serve a self-contained browser page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend the existing connection helper with schema initialization, typed database operations, transactions, and heartbeat persistence.
- `src/jobs.ts`: Add shared job/payload types, validation, and conversion from database rows to the required public representation.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement queue polling, processing, retries, heartbeat updates, recovery, and graceful shutdown.
- `ui/index.html`: Add the form, error region, job list, styling, and inline browser JavaScript.
- Leave all fixed files and `checks/` untouched; add no dependencies.

## Steps
1. **Define the schema and shared representation.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout = 5000` before enabling WAL.
   - Both entry points call the same initializer using `CREATE TABLE/INDEX IF NOT EXISTS`.
   - Store jobs with an integer insertion sequence, unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric `available_at` retry timestamp.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first processing, including submissions sharing a timestamp.
   - Store the worker heartbeat separately as a singleton row containing a timestamp in epoch milliseconds. Schema initialization must not refresh the heartbeat.
   - Use parameterized SQL. Centralize serialization so internal columns never leak and every endpoint returns the exact required shape, including explicit `null` values and `progress.total = steps`.

2. **Implement complete submission validation.**
   - Read request bytes fully and decode UTF-8 once; catch malformed JSON and request-stream failures.
   - Require the media type `application/json`, allowing case-insensitive matching and parameters such as `charset=utf-8`.
   - Require a non-null, non-array JSON object. Use `"body"` for media-type, parsing, or whole-body errors.
   - Enumerate own keys and report every unknown field. Validate all recognized fields independently and collect every offending field.
   - Require `input` to be a string with JavaScript length 1–1000 and nonempty `trim()`, but preserve the original input.
   - Apply numeric defaults only when a property is absent. Reject null, booleans, numeric strings, fractional values, and out-of-range values.
   - Validate any supplied `Idempotency-Key` against the exact regex and name it `"Idempotency-Key"` in errors. Reject duplicated key headers rather than silently selecting one.
   - Return `400 invalid_request` with a message and `fields` before any job mutation. Combine header and payload issues when both can be assessed.

3. **Implement atomic creation and idempotency.**
   - Normalize validated payloads into `{ input, steps, failAttempts }`.
   - In a short `BEGIN IMMEDIATE` transaction, look up any supplied key:
     - Matching stored input, steps, and fail-attempt count: return the existing job with `200`.
     - Different normalized payload: return `409 idempotency_conflict`.
     - Missing key: insert a new job using `randomUUID()`, queued status, zero attempts/progress, null result/error, and current timestamps.
   - Keep a database uniqueness constraint on the key as the final duplicate-prevention mechanism. SQL `NULL` permits independent submissions without keys.
   - Capture the newly inserted row inside the transaction and return that queued snapshot with `201`; a worker may claim it immediately after commit.
   - Always roll back failed transactions. Replays return the original job’s current state without updating its timestamps.

4. **Complete HTTP routing and lifecycle.**
   - Match paths separately from allowed methods:
     - `/`: `GET`, HTML.
     - `/health`: `GET`, JSON health.
     - `/api/jobs`: `GET` and `POST`.
     - `/api/jobs/:id`: `GET`.
   - Recognized paths with unsupported methods return `405 method_not_allowed`, preferably with an `Allow` header. Unknown paths and missing jobs return `404 not_found`.
   - Parse URLs safely and handle malformed encoded IDs without crashing.
   - Use one JSON response/error helper with `Content-Type: application/json; charset=utf-8`. Unexpected handler errors become structured `500` responses.
   - Health reports `"up"` only when the stored heartbeat is at most 3 seconds old; absent or stale heartbeats mean `"down"`.
   - Preserve the existing `new URL('../ui/index.html', import.meta.url)` lookup, which works from the compiled `dist/server.js`.
   - On `SIGTERM`/`SIGINT`, stop accepting connections, finish active requests, close the database, and exit. Bound draining so stalled clients cannot prevent shutdown.

5. **Implement the worker state machine.**
   - Initialize the database, recover interrupted work, and write a heartbeat immediately. Refresh it about every 500 ms during idle time, processing, and retry waits.
   - Poll about every 100 ms when idle. Select the oldest queued job whose `available_at` has passed, and claim it in a short transaction.
   - A new attempt atomically sets `running`, increments attempts, resets completed steps to zero, clears result/error, and updates `updatedAt`.
   - Process one job at a time using asynchronous 100 ms delays. Do not busy-wait or sleep inside a transaction.
   - After the first delay, if the attempt number is at most `failAttempts`, fail before writing any progress:
     - Attempts 1 or 2: atomically return to queued, retain zero progress and null result/error, and persist `available_at = now + 500 ms`.
     - Attempt 3: atomically set failed, error `"transient failure"`, and null result.
   - Otherwise persist progress after each delay. On the final step, atomically write completed progress, completed status, and `input.toUpperCase()`.
   - Refresh `updatedAt` on each job state/progress transition, not on heartbeats.
   - Waiting retries must not block other eligible queued jobs.

6. **Make recovery and shutdown explicit.**
   - For the required single-worker deployment, startup can immediately recover rows left running by the previous worker; no server participation or external communication is needed.
   - Requeue interrupted attempts below the three-attempt limit with zero progress and immediate availability; the next claim increments attempts normally.
   - If the interrupted row already records attempt 3, recover that recorded attempt from step zero without allocating attempt 4. Apply its failure predicate normally. This treats recovery of the final interrupted attempt as continuation and avoids either abandoning successful work or exceeding the retry cap.
   - Preserve persisted retry deadlines for jobs already queued. Never alter completed or failed jobs during startup.
   - On termination, stop claiming work and allow the current attempt to finish—at most about 2 seconds with 100 ms steps. Persist its completion or retry transition, clear the heartbeat, cancel timers, and close SQLite.
   - Ensure abrupt termination also works: each committed step survives, the stale heartbeat expires, and startup recovery handles the running row.

7. **Build the browser page.**
   - Include every specified `data-testid`, with `role="alert"` on `form-error` and `data-job-id` on each job item.
   - Give numeric fields defaults of 5 and 0. Use `novalidate` so API validation errors reach the alert instead of being intercepted by native form validation.
   - Submit input unchanged and convert numeric fields with `Number`; represent an empty numeric field as `null` so it is rejected rather than silently interpreted as zero.
   - Clear the form alert before each submission. On API rejection, display its message and every returned field name/message; preserve the entered values.
   - Fetch the list on load, after submission, and about every 500 ms. Use a single-flight refresh mechanism to prevent overlapping requests and stale responses overwriting newer state.
   - Render jobs in API order, with exact status text, `completed/total`, output for completed jobs, error for failed jobs, and empty result content otherwise.
   - Use DOM creation and `textContent` for all submitted text and server messages. Do not interpolate job data into HTML.
   - Keep background polling failures separate from submission validation errors, and continue polling after temporary failures.

8. **Build and verify the finished implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Use temporary databases for additional lifecycle and HTTP checks; the disclosed suites explicitly omit substantial validation, persistence, and UI coverage.
   - Keep any added verification source under `src/` or `ui/`, or run one-off commands without changing fixed files.

## Behaviours to verify
- **Independent startup:** Start each process first on a fresh nested database path, then the other; repeat simultaneous startup. Both become ready within 10 seconds.
- **Health:** Server alone reports down; running and idle workers report up; killing the worker produces down after heartbeat expiry.
- **Creation and representation:** Check all fields, explicit nulls, defaults, exact preservation of whitespace around valid input, ISO timestamps, and deterministic listing order.
- **Validation:** Exercise malformed JSON, arrays/null/scalars, missing/wrong content type, unknown fields, missing input, whitespace-only input, length boundaries, numeric strings, nulls, fractions, range boundaries, and invalid keys. Combine multiple invalid fields and verify none creates a job.
- **Idempotency:** Submit the same key concurrently, replay with explicit defaults and reordered properties, conflict on each payload field, and replay after restarting the server. Verify exactly one job exists; keyless submissions remain distinct.
- **Routing:** Check unknown paths, missing IDs, and wrong methods on every known route, including `/` and `/health`.
- **Processing:** Poll a 20-step job frequently enough to observe running state and intermediate progress; verify each ordinary step takes about 100 ms and completion uses JavaScript uppercase semantics.
- **Retries:** Test `failAttempts` from 0 through 5. Values 0–2 complete in 1–3 attempts; values 3–5 fail on attempt 3. Verify queued retry delays, zero failure progress, and no duplicated jobs/results.
- **Durability:** Stop and restart both processes using the same database. Kill the worker during processing and retry waiting, then restart it. Verify recovery, retained retry deadlines, persistent idempotency, and unchanged terminal jobs.
- **Shutdown:** Send `SIGTERM` while idle and processing; verify prompt clean exit and restartability.
- **Browser:** Submit valid and invalid jobs using the required selectors, inspect offending field names, observe updates within 2 seconds, reload to recover the list, and verify HTML-like input renders as text.

## Risks
- **Interrupted third-attempt semantics:** The task does not explicitly distinguish crash recovery from a new attempt at the retry limit. Implement and verify the continuation policy above so recovery cannot create attempt 4 or falsely fail work that should succeed.
- **SQLite contention:** Keep transactions short, initialize safely from either process, retain the busy timeout, and never hold locks during
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
