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
Keep the existing server and worker entry points and use Node.js built-ins only. Put schema initialization, durable job operations, and job serialization in shared modules, with SQLite as the only communication channel between processes. Use short transactions for submission and job claiming, persisted retry deadlines, and a database heartbeat for worker health. Serve a self-contained browser page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, transaction helpers, and durable job/heartbeat operations.
- `src/jobs.ts`: Add job and payload types, validation, canonical payload comparison, and conversion from database rows to the required API shape.
- `src/server.ts`: Implement routing, request parsing, validation responses, idempotent creation, job queries, health reporting, and shutdown.
- `src/worker.ts`: Implement sequential processing, observable progress, retries, recovery, heartbeat, and shutdown.
- `ui/index.html`: Add the submission form, job list, error region, styling, and inline browser JavaScript.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the shared database schema.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL initialization.
   - Have both processes initialize tables and indexes with `IF NOT EXISTS`, so either can start first.
   - Use a `jobs` table containing an insertion sequence (`INTEGER PRIMARY KEY AUTOINCREMENT`), unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO timestamps, nullable unique idempotency key, and retry eligibility time in epoch milliseconds.
   - Store a canonical payload string alongside the idempotency key, built from a fixed-order object containing `input`, `steps`, and `failAttempts` after defaults.
   - Add a singleton worker-heartbeat table holding the last heartbeat time. Only the worker writes heartbeat state.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first selection, including jobs created within the same millisecond.
   - Keep transactions synchronous and brief; never hold a transaction across a timer or request-body read. Roll back on exceptions.

2. **Implement validation and public serialization.**
   - Parse JSON into `unknown`. Reject null, arrays, primitives, and malformed JSON with a `"body"` field error.
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types.
   - For an object, accumulate errors for every unknown key and every invalid known field. Use own-property checks: defaults apply only to omitted properties, not explicit null.
   - Require `input` to be a string with JavaScript length 1–1000 and nonempty `trim()`, but store the original string unchanged.
   - Require actual integer numbers in the specified ranges; do not coerce strings.
   - Validate any supplied `Idempotency-Key` against the complete specified regex, including rejecting an empty header. Include header errors alongside discoverable body errors.
   - Centralize error responses, always including `fields` for `invalid_request`.
   - Centralize row serialization so every endpoint exposes exactly the specified job fields. Build `progress.total` from `steps`; expose output only as `{ output }` for completed jobs, and error only for failed jobs. Do not expose internal sequence, retry time, or idempotency data.

3. **Implement atomic submission and read operations.**
   - Validate the entire request before consulting idempotency records or inserting anything.
   - Inside `BEGIN IMMEDIATE`, look up a supplied key. Return the original job’s current representation with `200` if canonical payloads match, or `409 idempotency_conflict` if they differ.
   - Otherwise insert one UUID job with status `queued`, attempts/progress zero, null result/error, and equal creation/update timestamps.
   - Capture the inserted job representation inside the transaction and return it with `201` after committing. This guarantees the creation response remains queued even if the worker immediately claims it.
   - Retain the unique key constraint as a database-level guarantee across concurrent submissions and server restarts. Unkeyed submissions always insert a new row.
   - Implement newest-first listing and lookup by public ID using bound SQL parameters.

4. **Complete HTTP routing and server lifecycle.**
   - Route using the URL pathname, independently of query parameters.
   - Support `GET /`, `GET /health`, `GET|POST /api/jobs`, and `GET /api/jobs/:id` with exactly one ID segment.
   - Recognize paths before checking methods: unsupported methods on known routes return `405 method_not_allowed`; unknown paths and missing jobs return `404 not_found`.
   - Return JSON content types for all API responses and routing errors; the successful root page uses HTML.
   - Catch asynchronous body-read and handler failures without terminating the server. Handle disconnected requests without attempting duplicate responses.
   - Health returns `"up"` only when a stored heartbeat is no more than 3 seconds old; no heartbeat or a stale heartbeat means `"down"`.
   - Preserve `PORT`, `DATABASE_PATH`, and the existing module-relative HTML loading path, which also resolves correctly from `dist/server.js`.
   - On `SIGTERM`/`SIGINT`, stop accepting requests, allow active handlers to finish within a bounded shutdown window, close remaining connections if needed, then close SQLite.

5. **Implement the worker state machine.**
   - Write a heartbeat immediately after initialization and refresh it approximately every 500 ms, including during processing and retry waits.
   - Poll for work every 100 ms while idle. Select the oldest eligible queued job (`retry_at <= now`) and atomically mark it running, increment attempts, reset completed steps to zero, and clear result/error.
   - Process only one job at a time using asynchronous 100 ms sleeps.
   - After each sleep, if this attempt number is at most `failAttempts`, fail at the first step before recording progress. Otherwise persist the newly completed step and `updatedAt`.
   - For a transient failure before attempt 3, return the same row to queued with zero progress, null result/error, and `retry_at = now + 500 ms`. The persisted deadline controls eligibility even after restart.
   - For the third transient failure, atomically set status failed, error `"transient failure"`, null result, and attempts 3.
   - On the final successful step, atomically persist completed status, full progress, and `input.toUpperCase()` computed in JavaScript. Do not use SQLite’s `upper()`, which has different Unicode behavior.
   - Update `updatedAt` on job transitions and progress changes, while leaving `createdAt` unchanged.

6. **Recover interrupted work and shut down safely.**
   - Under the task’s single-worker model, inspect running jobs at worker startup and recover them before ordinary queued work.
   - Treat a previously running row as an interrupted attempt: restart its steps from zero while retaining its already-counted attempt number. This reprocesses the job without inventing a transient failure or exhausting the retry budget solely because a process died.
   - Apply the same first-step transient-failure rule to the recovered attempt. After an actual failure, subsequent attempts increment normally.
   - Recovery starts immediately, comfortably within the required 10-second allowance. Never select completed or failed rows.
   - On shutdown, stop claiming jobs and exit at the next short timer boundary, leaving any unfinished job durably running for recovery. Clear the heartbeat on graceful exit, stop timers, and close SQLite.
   - A `SIGKILL` requires no cleanup: committed progress/status survives, the heartbeat expires, and startup recovery handles the interrupted row. Server startup must never reset running jobs.

7. **Build the browser UI.**
   - Add every required `data-testid` exactly as specified, with a textarea for input, numeric fields defaulting to 5 and 0, a submit button, and an initially empty `role="alert"` region.
   - Use `novalidate` so native browser constraints do not suppress the API validation errors the UI must display.
   - Submit all three fields, preserving input text and converting numeric field values to numbers. Ensure blank or unparseable numeric entries reach the API as invalid values rather than silently becoming defaults.
   - On API rejection, render the rejection message and every returned field name/message. Clear the error when a new submission begins and after success.
   - Disable the submit button only while the request is pending, restoring it in `finally`.
   - Fetch jobs on page load, after successful submission, and approximately every 500 ms. Serialize refreshes or ignore stale responses so older responses cannot overwrite newer job state.
   - Render jobs in API order with `data-job-id`, status, exact `completed/total` text, and output/error/empty result as appropriate.
   - Use DOM construction and `textContent` for submitted input, outputs, and errors. Keep polling failures separate from the form rejection region.

8. **Validate the implementation without changing fixed checks.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with temporary local scripts or manual HTTP/browser checks covering the cases below. Use isolated database paths and terminate all spawned processes afterward.

## Behaviours to verify
- **Startup and configuration:** Start worker first, server first, and both simultaneously with a fresh nested database path. Confirm readiness within 10 seconds and the documented defaults.
- **Validation:** Submit malformed JSON, non-objects, missing/wrong content types, unknown fields, nulls, numeric strings, fractional/out-of-range numbers, whitespace-only input, length boundaries, and invalid keys. Combine multiple errors and verify all offending fields appear and job count stays unchanged.
- **Job representation:** Check queued, running, completed, and failed responses from creation, replay, detail, and list endpoints; verify exact null/result/error semantics and ISO timestamps.
- **Idempotency:** Replay omitted versus explicit defaults, change each payload field, submit concurrent requests sharing a key, and replay after server restart. Confirm exactly one job per key and distinct jobs without keys.
- **Processing:** Poll a 20-step job frequently enough to observe intermediate progress and measure pickup and step timing. Queue several jobs and verify sequential oldest-first processing.
- **Retries:** Test `failAttempts` from 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0–2, and failure on attempt 3 for values 3–5. Observe queued retry intervals of approximately 500 ms and no duplicate jobs.
- **Durability:** Kill the worker during progress, during a retry wait, and during its third attempt. Restart with the same database and verify recovery, preserved retry deadlines, and terminal jobs remaining unchanged. Also stop/restart both processes.
- **Health and shutdown:** Observe up while idle and processing, down within 3 seconds after abrupt worker death, and clean process exits on `SIGTERM`.
- **Routes:** Exercise wrong methods on all known routes, unknown paths, missing IDs, and query strings; verify status codes, JSON error shapes, and content types.
- **Browser:** Submit successful and invalid jobs, verify all selectors and field-name errors, observe updates within 2 seconds, reload to confirm persistence, and submit HTML-like text to verify safe rendering.

## Risks
- **SQLite startup contention:** Both processes initialize the database; retain the busy timeout before WAL setup and avoid long transactions.
- **Creation/worker race:
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
