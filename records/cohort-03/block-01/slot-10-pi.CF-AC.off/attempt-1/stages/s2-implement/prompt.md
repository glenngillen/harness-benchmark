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
Implement the API and worker as separate Node.js processes sharing a SQLite database, with no direct communication between them. Extend the existing database helper to initialize durable job state and a worker heartbeat, and keep transactions short so polling and progress updates remain responsive. Use a sequential worker loop with persisted retry deadlines and explicit recovery of interrupted work. Serve a dependency-free HTML page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend database initialization; add schema, typed row mapping, transactional submission, job queries, worker transitions, and heartbeat operations.
- `src/jobs.ts`: Add shared job/payload types, validation, normalized payload comparison, and API error types.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, progress updates, retries, restart recovery, and graceful shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, and polling script.
- Leave all fixed files and `checks/` unchanged. Preserve existing commands and TypeScript `.ts` import conventions.

## Steps
1. **Define the shared model and database schema.**
   - Keep `openDatabase()` creating the parent directory and setting `busy_timeout` before WAL mode.
   - Initialize the same schema from either process using `CREATE TABLE IF NOT EXISTS`, so either can start first.
   - Store jobs with:
     - An internal integer insertion sequence for deterministic ordering.
     - Unique public ID generated with `randomUUID()`.
     - `status`, exact `input`, `steps`, `fail_attempts`, `attempts`, completed-step count, nullable output and error, and ISO creation/update timestamps.
     - Nullable unique idempotency key.
     - A persisted numeric `available_at` timestamp for retry eligibility.
   - Store worker heartbeat time in a separate singleton table. Opening the database from the server must not refresh this heartbeat.
   - Add an index supporting selection of eligible queued jobs.
   - Use prepared statements and bound parameters throughout.
   - Provide one row-to-job mapper that emits exactly the required public shape, including explicit nulls, nested progress, and no internal database fields.
   - Order lists by insertion sequence descending and queued selection by sequence ascending; timestamps alone cannot resolve simultaneous inserts reliably.

2. **Implement validation before any mutation.**
   - Read and concatenate request bytes before UTF-8 decoding and JSON parsing.
   - Require the media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Report missing or incorrect content type as field `body`.
   - Reject malformed JSON, empty bodies, null, arrays, and primitive roots with field `body`.
   - For object bodies, collect all offending fields rather than stopping at the first:
     - Unknown own property names.
     - Missing or invalid `input`; use JavaScript `.length` and `.trim()` only to validate, never to alter the stored input.
     - Wrong types, nonintegers, and out-of-range numeric fields.
   - Apply defaults only to absent properties; explicit `null` is invalid.
   - Validate a present `Idempotency-Key` against the exact required expression and report failures under `Idempotency-Key`. Reject ambiguous multiple header values rather than silently picking one.
   - Aggregate header and body-field errors when possible. Return `400` with `error.code`, a useful message, and required `fields`.
   - Construct normalized payloads in a fixed field order: `input`, `steps`, `failAttempts`.

3. **Make submission and idempotency atomic.**
   - Use a short `BEGIN IMMEDIATE` transaction around key lookup and insertion; always roll back on failure.
   - If a key exists, compare its job’s immutable input, steps, and fail-attempt count with the normalized request:
     - Equal: return the original job’s current representation with `200`.
     - Different: return `409 idempotency_conflict`.
   - Otherwise insert one queued job with attempts/progress zero, null result/error, and equal creation/update timestamps.
   - Enforce uniqueness in SQLite as well as in application logic.
   - Capture the inserted queued representation within the transaction, commit, and return it with `201`. Do not reread after committing: the worker could already have changed its status.
   - Requests without keys always insert distinct jobs. Validation errors and conflicts insert nothing.

4. **Complete HTTP routing and lifecycle.**
   - Route by URL pathname, ignoring query strings.
   - Implement:
     - `GET /`: existing HTML file, resolved relative to `import.meta.url`; this path already works from `dist/server.js`.
     - `GET /health`: `status: "ok"` and worker `"up"` only when its persisted heartbeat is no more than 3 seconds old.
     - `POST /api/jobs`: validated submission.
     - `GET /api/jobs`: mapped jobs newest first.
     - `GET /api/jobs/:id`: mapped job or `404 not_found`.
   - Match a detail route only for one nonempty ID segment. Handle malformed path encoding without crashing.
   - For a recognized path with an unsupported method, return `405 method_not_allowed`; for an unknown path, return `404 not_found`. Include an appropriate `Allow` header for 405 responses.
   - Centralize JSON responses and the required error envelope. Serve HTML only for the page.
   - Catch asynchronous request-handler errors so malformed requests or database errors do not terminate the server; unexpected errors receive a generic JSON `500`.
   - Retain `PORT` default `3000` and `DATABASE_PATH` default `data/jobs.db`.
   - On SIGTERM/SIGINT, stop accepting connections, allow active handlers a bounded time to finish, close lingering connections if necessary, and close SQLite only after handlers stop using it.

5. **Implement sequential worker processing.**
   - Write a heartbeat immediately after initialization and every 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms. In a short transaction, select the oldest eligible queued job and set it to running, increment attempts, reset progress to zero, clear result/error, and update its timestamp.
   - Commit before waiting or processing; never hold a write transaction across a timer.
   - For each step, await approximately 100 ms.
   - At the first step, if the current attempt number is at most `failAttempts`, fail before incrementing progress:
     - Attempts 1–2: set status queued, progress zero, null result/error, and `available_at = now + 500 ms`.
     - Attempt 3: set status failed, progress zero, null result, and error exactly `"transient failure"`.
   - Persist successful step progress and `updatedAt` after every step.
   - On the last successful step, atomically set completed progress, completed status, and output using JavaScript `input.toUpperCase()`.
   - Exclude retries whose deadline has not arrived; allow other eligible queued jobs to run while they wait.
   - Never select completed or failed jobs.

6. **Handle restarts and shutdown explicitly.**
   - Treat a durable running row as an interrupted logical attempt when the sole worker restarts. Process it again from step zero before selecting fresh work, keeping its recorded attempt number.
   - Reset its partial progress and refresh `updatedAt` before replaying its steps. Apply the same transient-failure decision using that recorded attempt number.
   - This resumes the already-started attempt rather than creating a fourth attempt after a crash during attempt three. Increment attempts only when claiming a queued job for a new attempt.
   - Persisted retry deadlines remain authoritative after restart; do not restart retry delays or reset attempt counts.
   - On SIGTERM/SIGINT, stop claiming jobs and finish the current bounded attempt, including its final completed/queued/failed transition. Keep heartbeating until processing stops, then clear the heartbeat, cancel timers, and close SQLite.
   - After SIGKILL, the running row remains recoverable and heartbeat freshness naturally expires. No server startup action should reset running jobs.
   - Scope this recovery policy to the requested single worker process; do not introduce unnecessary multi-worker lease machinery.

7. **Build the browser page.**
   - Add every required `data-testid`, with `data-job-id` on each job item and `role="alert"` on the form-error region.
   - Provide defaults of `5` and `0` for steps and fail attempts.
   - Use `novalidate` so browser constraints do not prevent API validation from returning field-specific errors.
   - Submit exact input text and numeric conversions of nonempty numeric fields as JSON. Represent empty numeric fields as invalid values rather than accidentally converting them to zero.
   - Clear the error region when a new submission starts and after success. On API rejection, display the rejection message and each returned field name/message.
   - Disable the submit button while its request is pending and restore it in `finally`.
   - Load the list immediately and poll every 500 ms using a loop that avoids overlapping fetches. Refresh promptly after successful submission.
   - Render newest-first items with exact status text, `completed/total`, completed output, failed error, or an empty result region as appropriate.
   - Use DOM creation and `textContent`, never interpolate submitted input or output into HTML.
   - Keep polling failures separate from submission validation errors, and continue polling after temporary network failures.

## Behaviours to verify
- **Existing commands:** Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`. The disclosed checks do not cover the entire task.
- **Startup order:** With a fresh database in a missing parent directory, start worker first, server first, and both together. Confirm startup within 10 seconds and no schema/WAL lock failures.
- **Health:** Server alone reports down; a worker reports up while idle and busy. After SIGKILL, health changes to down once the last heartbeat exceeds 3 seconds.
- **Validation:** Exercise malformed JSON, nonobject bodies, missing/non-JSON content type, unknown properties, numeric strings, nulls, fractions, range boundaries, whitespace-only input, and invalid keys. Submit several invalid fields together and verify all names appear and the job count is unchanged.
- **String semantics:** Preserve leading/trailing whitespace and use JavaScript UTF-16 length and uppercase behavior, including non-ASCII input.
- **Idempotency:** Compare omitted defaults against explicit defaults, retry after completion and after restarting the server, submit conflicting payloads, and send concurrent requests with the same key. Confirm exactly one durable job.
- **Routing:** Check wrong methods on every recognized route, nonexistent IDs, unknown paths, and malformed encoded paths; verify JSON error envelopes.
- **Processing:** Poll a 20-step job frequently enough to observe intermediate progress. Confirm idle pickup within 1 second, approximately 100 ms per step, and only one running job.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3 respectively, then terminal failure at attempt 3 for the last two cases. Observe queued retry intervals and zero progress on simulated failures.
- **Durability:** Stop/restart both processes with the same database using SIGTERM and SIGKILL. Kill the worker during progress, during retry waiting, and during the third attempt; verify recovery without losing jobs, exceeding the retry cap, or reprocessing terminal jobs.
- **Browser:** Submit valid and invalid values, verify all selectors and alert content, observe status/progress changes within 2 seconds, reload to recover persisted jobs, and confirm HTML-like input displays as li
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
