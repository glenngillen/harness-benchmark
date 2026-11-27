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
Keep the existing TypeScript entry points and commands, using Node.js built-ins only. Initialize the same SQLite schema from both processes, with short transactions for job creation, claims, progress, retries, and worker heartbeats. The server handles validation and HTTP responses; the worker executes one job at a time using asynchronous timers. Serve a self-contained browser page from `ui/index.html` that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend the existing database initialization with schema creation, transactions, prepared queries, and shared job serialization.
- `src/jobs.ts` (new): Define job/payload types, submission validation, normalization, and structured API errors.
- `src/server.ts`: Implement routing, request parsing, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, persisted retry scheduling, interrupted-work recovery, and shutdown.
- `ui/index.html`: Build the form, validation-error region, job list, and polling logic with inline CSS and JavaScript.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Establish the database model.**
   - Preserve parent-directory creation and the existing ordering of `PRAGMA busy_timeout = 5000` before enabling WAL.
   - Run idempotent schema initialization in both processes so either can start first.
   - Store jobs with an internal integer creation sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, and retry availability time in epoch milliseconds.
   - Store a nullable unique idempotency key on the job row. SQLite permits multiple `NULL` values, supporting independent submissions without keys. The immutable input/steps/failAttempts columns provide the normalized payload comparison.
   - Add a singleton worker-state row containing its last heartbeat timestamp. Only the worker updates it; server startup must not mark the worker alive.
   - Order lists by creation sequence descending and queued claims by sequence ascending. This avoids timestamp ties and preserves creation order across retries.
   - Provide one serializer that emits exactly the public job shape, including nested progress, explicit `null` values, and no internal fields.

2. **Implement complete validation before database mutation.**
   - Accept `application/json` case-insensitively, including parameters such as `; charset=utf-8`. Missing or other media types produce an invalid-request error naming `body`.
   - Read the body asynchronously and catch malformed JSON. Reject arrays, `null`, and scalar values with a `body` error.
   - Collect every discoverable offending field rather than returning after the first field error.
   - Enumerate own keys and reject every unknown field, including names such as `__proto__`.
   - Validate `input` by JavaScript `.length` and `.trim()`, preserving the original string for storage.
   - Default `steps` and `failAttempts` only when absent; explicit `null`, strings, booleans, fractions, and out-of-range numbers are invalid.
   - Validate a present `Idempotency-Key` against the exact required regular expression and report its canonical field name. Check presence separately from truthiness so an empty header is rejected.
   - Return `400` with `error.code = "invalid_request"`, a readable message, and the collected `fields` array. Header errors can be collected even when the body cannot be parsed.

3. **Implement atomic submission and HTTP routes.**
   - Use a short `BEGIN IMMEDIATE` transaction for keyed submission: look up the key, compare normalized payload values, and either return the existing job, report a conflict, or insert the new row. Roll back on exceptions.
   - Generate public IDs with `randomUUID()`. New rows start queued with attempts/progress zero, no result/error, and equal creation/update timestamps.
   - Capture the inserted job within the transaction for the `201` response. Do not reread after committing: the worker could already have changed its status.
   - Return the current original job for a matching replay with `200`, and `409 idempotency_conflict` for differing normalized payloads. Invalid requests must never consume a key.
   - Implement `GET /api/jobs`, `GET /api/jobs/:id`, and `GET /health`; report worker up only when its recorded heartbeat is within the preceding 3 seconds.
   - Match known path patterns before checking methods. Wrong methods on `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` return `405 method_not_allowed`; unknown paths and missing jobs return `404 not_found`.
   - Use a shared JSON response helper for all API successes and errors. Unexpected handler errors should become a structured `500` response without terminating the server or exposing internal details.
   - Preserve the existing module-relative HTML lookup, which resolves from `dist/server.js` to `ui/index.html`, and honor `PORT`.

4. **Implement the worker state machine.**
   - Write a heartbeat immediately on startup and approximately every 500 ms thereafter, including during processing and retry waits.
   - Poll for work every 100 ms while idle. In a short transaction, claim the oldest eligible queued job whose retry availability time has arrived.
   - Starting a new attempt atomically changes status to running, increments attempts, resets completed steps to zero, clears result/error, and updates `updatedAt`.
   - Await approximately 100 ms before each step. Never hold a SQLite transaction across a timer.
   - At the first step, if the attempt number is at most `failAttempts`, fail before recording any progress:
     - Below attempt 3, return the same job to queued with a persisted availability time 500 ms in the future, zero progress, and null result/error.
     - At attempt 3, mark it failed with error exactly `"transient failure"` and null result.
   - Otherwise persist each completed step and update the timestamp. Commit the last step and terminal completion together, setting output with JavaScript `input.toUpperCase()`.
   - Process only one job at a time. Delayed retries remain queued; other eligible jobs may run while they wait.

5. **Make restarts and shutdown explicit.**
   - At worker startup, recover any persisted running job before claiming ordinary queued work. Under the requested single-worker deployment, such work belongs to the previous worker.
   - Treat crash recovery as replaying the interrupted logical attempt: retain its persisted attempt number, reset its progress, and execute that attempt again from step one. Increment attempts only when starting a newly queued attempt. This prevents a crash during attempt 3 from creating attempt 4 or stranding the job.
   - Apply the same transient-failure condition when replaying an interrupted attempt. Preserve retry deadlines for jobs already queued, and never select completed or failed jobs.
   - Keep heartbeat updates independent of the processing loop, and clear the heartbeat on graceful worker shutdown.
   - On worker `SIGTERM`, stop claiming work, stop timers, and leave interrupted running state recoverable before closing SQLite. Check the stop flag after asynchronous waits so no writes occur after closure.
   - On server `SIGTERM`, stop accepting connections, finish active handlers, close idle connections, and close SQLite after outstanding database users finish. Bound shutdown if a client holds a connection open.
   - Handle `SIGINT` similarly. Do not clear tables, reset terminal state, or perform server-side recovery.

6. **Build the browser interface.**
   - Include every required `data-testid`, with a `job-form`, input textarea, numeric controls defaulting to 5 and 0, submit button, empty `form-error` with `role="alert"`, and `job-list`.
   - Use `novalidate` so browser constraints do not suppress API validation errors. Convert numeric field values to numbers without permissive `parseInt` coercion; send blanks as an invalid value such as `null`.
   - Submit JSON to `/api/jobs`. Clear the previous error when submitting; on rejection, show the API message and every offending field name. Keep the form usable afterward and prevent overlapping submissions.
   - Fetch jobs immediately and poll about every 500 ms using a single in-flight refresh. Refresh after successful submission without allowing older responses to overwrite newer data.
   - Render jobs newest first. Each item carries `data-job-id`, status text, progress formatted exactly as `completed/total`, and output/error only for terminal states.
   - Use DOM creation and `textContent` for submitted text and errors. Preserve output whitespace with CSS rather than interpreting strings as HTML.
   - Handle polling failures without erasing existing jobs or producing unhandled promise rejections.

7. **Build and validate the finished implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The existing checks cover basic startup, submission, selected validation, completion, one retry, and idempotency. Supplement them with the restart, timing, validation, and UI checks below.
   - Keep any additional verification source under `src/` if committed; do not modify fixed checks or dependency/configuration files.

## Behaviours to verify
- **Startup and configuration:** Start each process first against a fresh nested `DATABASE_PATH`; verify readiness within 10 seconds and custom `PORT` handling.
- **Validation:** Exercise malformed/empty JSON, non-object bodies, missing/wrong content types, unknown fields, multiple simultaneous errors, whitespace input, Unicode length boundaries, numeric strings, nulls, fractions, bounds, and invalid keys. Verify field names and unchanged job count.
- **Response shape and routing:** Inspect every job-returning endpoint for exact fields and nulls. Check missing IDs, unknown paths, and wrong methods independently.
- **Idempotency:** Compare omitted versus explicit defaults; change each payload field; issue concurrent same-key submissions; replay after server restart. Expect one durable job and the correct `201`/`200`/`409` outcomes.
- **Ordering:** Submit several jobs while the worker is stopped, including rapid submissions sharing timestamps. Verify newest-first listing and oldest-first processing.
- **Progress and timing:** Poll a 20-step job frequently enough to observe intermediate progress. Confirm pickup within 1 second, roughly 100 ms steps, and progress reset on a new attempt.
- **Retries:** Test `failAttempts` values 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3 respectively, then terminal failure at attempt 3 for values 3 and 5. Verify zero progress on simulated failures and persisted retry delays.
- **Health:** Verify down before worker startup, up while idle and busy, and down within approximately 3 seconds after `SIGKILL`.
- **Durability:** Kill the worker mid-progress, including during attempt 3 after two simulated failures; restart and verify recovery within the deadline. Restart both processes with queued, retrying, completed, and failed jobs and verify preserved state and IDs.
- **Graceful shutdown:** Send `SIGTERM` to each process and verify timely exit without database errors; restart and verify interrupted work recovers.
- **UI:** Use the specified selectors to submit valid and invalid forms, observe all offending field names, and watch progress/results update within 2 seconds. Confirm failed-job text and safe rendering of HTML-like input.

## Risks
- **SQLite contention:** Keep transactions synchronous and brief, preserve WAL/busy-timeout setup, and never await inside a transaction.
- **Idempotency races:** A lookup followed by an unprotected insert is insufficient; combine transactional lookup/insertion with a database uniqueness constraint.
- **Crash recovery accounting:** Keep replay of an interrupted logical attempt distinct from starting a retry.
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
