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
Implement the application with Node.js built-ins, retaining the existing server, worker, database module, and HTML entry points. SQLite will hold jobs, idempotency keys, retry deadlines, and worker heartbeat state; both processes will initialize the schema so either can start first. Use short transactions for submission and state transitions, with asynchronous timers outside transactions for processing and polling. The browser will submit through the API and poll for updates.

## Files
- `src/db.ts`: Extend database initialization with schema creation, typed job serialization, and shared persistence operations.
- `src/jobs.ts`: Add job and request types, normalized payload validation, and structured validation errors.
- `src/server.ts`: Replace the placeholder routes with the API, HTML serving, request handling, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, observable progress, durable retries, heartbeat updates, crash recovery, and shutdown.
- `ui/index.html`: Implement the submission form, error region, job list, polling, and modest inline styling.
- Leave all fixed files, dependencies, commands, and `checks/` unchanged.

## Steps
1. **Define the schema and public representation.**
   - Preserve `openDatabase()`’s parent-directory creation and `busy_timeout` before WAL configuration.
   - Create tables and indexes idempotently in both processes.
   - Store jobs with an integer insertion sequence, unique public UUID, status, input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, and numeric `available_at` retry deadline.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first selection, including jobs created within the same millisecond.
   - Store a worker heartbeat in a separate singleton table.
   - Provide one serializer that returns exactly the required job shape. Internal sequencing, deadlines, and keys must not appear in responses.
   - Use prepared statements and bound values throughout. Wrap multi-statement writes in `BEGIN IMMEDIATE` with commit/rollback; never hold a transaction across an `await`.

2. **Implement complete submission validation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Read and parse the complete request body, handling malformed JSON and request-stream errors without crashing the server.
   - Require a non-null, non-array object. Enumerate its own keys and report every unknown field.
   - Validate `input` using JavaScript `.length`, preserving the original string; use `.trim()` only to reject whitespace-only input.
   - Default `steps` and `failAttempts` only when absent. Reject `null`, strings, booleans, fractions, and out-of-range values.
   - Validate a supplied `Idempotency-Key` against the exact regex, including rejecting empty or duplicate header values.
   - Accumulate all identifiable field errors before returning `400 invalid_request`; whole-body problems use `"body"`. No validation failure may write a job or reserve a key.

3. **Make creation and idempotency atomic.**
   - Inside one immediate transaction, look up a supplied key and compare the stored input, steps, and fail-attempt count against the validated payload after defaults.
   - Return the original job’s current representation with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise generate a UUID with `node:crypto`, insert a queued job with zero attempts/progress and null result/error, and commit.
   - Capture the inserted queued representation within the transaction and return it with `201`, so a fast worker cannot change the creation response to `running`.
   - Enforce uniqueness in SQLite as well as application logic. Requests without keys always insert.

4. **Implement the HTTP routes and lifecycle.**
   - Route on URL pathname independently of method. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`; unknown paths get `404`, while unsupported methods on recognized paths get `405`.
   - Return the required structured JSON errors and JSON content type for all API responses.
   - Implement list and detail reads through the shared serializer, with missing IDs returning `404 not_found`.
   - Calculate health from the persisted heartbeat: `"up"` only when its age is at most 3 seconds; absent or stale means `"down"`.
   - Continue loading `../ui/index.html` relative to `import.meta.url`, which works from the compiled `dist/server.js`.
   - Wrap asynchronous request handling so unexpected failures return a structured `500` when possible and are logged without exposing internals.
   - Keep the HTTP server reference. On `SIGTERM`/`SIGINT`, stop accepting connections, allow active handlers a bounded drain period, then close remaining connections and the database. Guard against duplicate shutdown signals.

5. **Implement worker processing and durable retries.**
   - Initialize the schema, write a heartbeat immediately, and refresh it every 500 ms during idle periods, steps, and retry waits.
   - Poll for eligible work every 100 ms. Select the oldest queued job whose persisted `available_at` has passed; delayed retries must not prevent other eligible work from running.
   - Claim a job atomically, setting `running`, incrementing attempts, resetting progress, clearing output/error, and updating `updatedAt`.
   - Process only one job at a time. Await about 100 ms per step and commit each completed step separately.
   - On attempts numbered at or below `failAttempts`, wait for the first step’s interval and fail before incrementing progress.
   - For failures before attempt 3, atomically return the same job to `queued`, leave public error/result null, and set `available_at` to approximately 500 ms later.
   - On the third simulated failure, atomically set `failed`, error `"transient failure"`, null output, and zero progress.
   - On successful processing, atomically commit the final progress value, `completed`, and `input.toUpperCase()` as output.
   - Update `updatedAt` on every job transition and progress write, but not heartbeat writes.

6. **Recover interrupted work and shut down predictably.**
   - Under the task’s single-worker model, scan `running` jobs when the worker starts, before claiming queued jobs.
   - Replay an interrupted attempt from progress zero using its already-persisted attempt number. Treat this as recovery of that attempt, rather than another transient-failure retry; this avoids exceeding three attempts or incorrectly failing a successful third attempt interrupted by a crash.
   - Apply the same first-step failure rule and normal terminal transitions during recovery. Never reset or process completed/failed jobs.
   - Persisted queued retry deadlines must survive restarts; do not replace them with fresh delays.
   - On shutdown, stop claiming new jobs and exit the active processing loop at the next short timer boundary. Leave unfinished work durably `running` for startup recovery.
   - Stop heartbeat updates, remove the heartbeat on clean exit, and close SQLite. After `SIGKILL`, the stale timestamp naturally causes health to become `"down"` within 3 seconds.

7. **Build the browser UI.**
   - Add every specified `data-testid`, including `form-error` with `role="alert"` and `data-job-id` on each job item.
   - Use a textarea for input and numeric controls defaulting to 5 and 0. Submit the original text and numeric conversions as JSON; treat empty numeric controls as invalid values rather than silently converting them to defaults.
   - Set `novalidate` on the form so browser validation does not suppress API rejection messages.
   - Clear the error region before each submission and after success. Display the API error message plus every returned offending field name and message on rejection.
   - Fetch jobs immediately and poll approximately every 300–500 ms using a non-overlapping request loop. Refresh promptly after successful submissions.
   - Render newest first, with status, `completed/total`, and either output or failure text in the required descendants.
   - Use DOM creation and `textContent` for submitted input, output, and error messages.
   - Keep polling after temporary network failures without replacing the submission error region or creating unhandled promise rejections.

8. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with focused manual or temporary-script checks for validation boundaries, concurrency, timing, restarts, and the UI. Do not modify the supplied checks.
   - Use isolated temporary database paths for these checks and ensure spawned processes are stopped afterward.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both concurrently with a fresh nested `DATABASE_PATH`; verify startup within 10 seconds and the configured port.
- **Validation:** Exercise malformed JSON, arrays/null/scalars, missing content type, multiple invalid fields, unknown keys, numeric strings, bounds, whitespace input, invalid keys, and Unicode string lengths. Verify named field errors and unchanged job counts.
- **Exact representation:** Inspect creation, running, retrying, completed, and failed responses; check nullability, timestamps, attempts, progress totals, and preserved input.
- **Idempotency:** Submit equivalent defaulted payloads, conflicts, concurrent same-key requests, and replays after server restart. Verify one job per key and distinct jobs without keys.
- **Ordering and pickup:** Queue several jobs while the worker is stopped, then start it. Verify oldest-first processing and newest-first listing; measure idle pickup below 1 second.
- **Progress and results:** Poll a 20-step job frequently to observe incremental progress and roughly 100 ms steps. Verify output with JavaScript Unicode uppercase behavior.
- **Retries:** Test `failAttempts` 0 through 5. Verify attempt counts, zero progress on failed attempts, 250–2000 ms retry delays, successful third attempts, and terminal failure after three simulated failures.
- **Health:** Verify `"down"` before worker startup, `"up"` during idle and processing, and `"down"` within 3 seconds after killing the worker.
- **Durability:** Restart both processes against the same database after graceful shutdown and `SIGKILL`; verify all IDs and terminal states persist. Kill the worker during progress, during retry delay, and during the third successful attempt; confirm recovery without duplicate jobs or results.
- **Routes:** Exercise unknown paths, missing IDs, and wrong methods on each recognized route; verify status codes, error codes, and JSON content type.
- **UI:** Submit valid and invalid forms; inspect all required selectors, numeric request types, field names in alerts, job ordering, progress updates within 2 seconds, completed/failed output, and literal rendering of HTML-like input.
- **Shutdown:** Send `SIGTERM` while idle and busy; confirm both processes exit promptly and the database reopens cleanly.

## Risks
- **SQLite contention:** Keep writes short, preserve WAL and busy-timeout initialization order, and avoid timers or HTTP reads inside transactions.
- **Creation-response races:** Serialize the new queued row before releasing the creation transaction.
- **Crash recovery versus retry accounting:** Keep interrupted-attempt recovery distinct from a new retry; otherwise an interrupted third attempt can become attempt 4 or fail incorrectly.
- **Heartbeat starvation:** Run heartbeat updates independently of job selection and processing waits.
- **Validation shortcuts:** Truthiness defaults, numeric coercion on the server, and early return on the first invalid field violate the contract.
- **Browser validation
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
