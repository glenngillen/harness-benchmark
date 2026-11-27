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
Keep the existing TypeScript entry points, npm commands, and dependency-free setup. Put schema initialization and durable job operations in shared SQLite modules used independently by the HTTP server and worker. Use short transactions for submission and claiming, asynchronous timers for processing, and database timestamps for worker health and retry scheduling. Serve a self-contained browser page that submits jobs and polls their state.

## Files
- `src/db.ts`: Extend the existing database opener with shared, repeatable schema initialization; preserve directory creation, busy timeout, and WAL.
- `src/jobs.ts`: Add job types, row serialization, transactional submission/idempotency, ordered queries, and worker state transitions.
- `src/validation.ts`: Add request validation and normalized payload construction.
- `src/server.ts`: Replace the placeholder with the HTTP API, HTML serving, error handling, and graceful shutdown.
- `src/worker.ts`: Replace the idle loop with heartbeat, recovery, claiming, processing, and retry logic.
- `ui/index.html`: Implement the form, validation feedback, job list, and automatic refresh.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the SQLite schema and shared representation.**
   - Both processes call the same initializer before doing work, so either can start first.
   - Preserve `PRAGMA busy_timeout = 5000` before enabling WAL. Use `CREATE TABLE/INDEX IF NOT EXISTS`, prepared statements, and short transactions.
   - Create a `jobs` table containing:
     - An integer insertion sequence for deterministic ordering and a unique public UUID.
     - `input`, `steps`, `fail_attempts`, status, attempt count, completed step count, nullable output/error, and ISO creation/update timestamps.
     - An integer `available_at` timestamp for retry eligibility.
     - A nullable unique idempotency key and canonical normalized payload.
   - Create a singleton worker-heartbeat row with a nullable timestamp in epoch milliseconds. Initialization must not refresh that timestamp.
   - Serialize rows through one function into exactly the public job shape. Keep scheduling and idempotency columns private; emit explicit `null` values for absent result/error.
   - Order listings by insertion sequence descending, and eligible queued work by sequence ascending. Do not rely solely on timestamps, which can tie.

2. **Implement validation before any database mutation.**
   - Read the complete request body asynchronously and parse it once. Catch malformed JSON and request-stream errors without crashing the server.
   - Require the media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` field error.
   - Reject null, arrays, and primitive bodies with a `"body"` field error.
   - For object bodies, collect every independently offending field:
     - Every unknown own property.
     - Missing/non-string input, JavaScript length outside 1–1000, or whitespace-only input.
     - Present numeric fields that are not numbers, integers, or within their specified ranges.
   - Apply defaults only when properties are absent; explicit `null` is invalid. Preserve input exactly.
   - Validate the optional `Idempotency-Key` independently against the specified regex; empty or duplicate header values must not silently become “no key.”
   - Return `400 invalid_request` with a message and `fields` array. Where body parsing fails, still include an independently invalid key.
   - Build the canonical payload using a fixed field order after defaults: `JSON.stringify({ input, steps, failAttempts })`.

3. **Implement atomic creation and replay.**
   - Generate public IDs with `randomUUID()`.
   - Inside `BEGIN IMMEDIATE`, look up a supplied key. Return the existing job for an identical normalized payload, or a conflict for a different payload.
   - Otherwise insert a queued row with attempts/progress zero, null output/error, and equal creation/update timestamps. Commit before responding.
   - Use the unique key constraint as database-level protection; roll back on exceptions.
   - Return a snapshot of the inserted row captured within the transaction, ensuring the `201` response remains queued even if the worker immediately claims it.
   - Replays return the original job’s current state with `200`. Unkeyed requests always insert new rows.

4. **Complete HTTP routing and lifecycle.**
   - Retain the existing URL-relative loading of `../ui/index.html`, which works from `dist/server.js`.
   - Implement:
     - `GET /`: HTML.
     - `GET /health`: JSON with worker up only when its heartbeat is at most 3 seconds old.
     - `POST /api/jobs`: validated creation/replay.
     - `GET /api/jobs`: `{ jobs }`, newest first.
     - `GET /api/jobs/:id`: one job or `404 not_found`.
   - Classify known path patterns before dispatching methods. Wrong methods on these paths return `405 method_not_allowed`, including a missing job’s detail path; unrelated paths return `404 not_found`.
   - Use a shared JSON response/error helper. Catch asynchronous handler failures and send a structured `500` if the response is still writable.
   - Honor `PORT` and `DATABASE_PATH` defaults.
   - On SIGTERM/SIGINT, stop accepting requests, allow active handlers to settle, close remaining connections after a short bounded grace period, then close SQLite. Avoid closing the database while handlers can still use it.

5. **Implement the worker’s normal state machine.**
   - Write a heartbeat immediately on startup, then approximately every 500 ms while idle or processing.
   - Poll approximately every 100 ms when idle. In a short transaction, select the oldest queued job with `available_at <= now`, mark it running, increment attempts, reset progress to zero, clear output/error, and update its timestamp.
   - Process one job at a time. Never keep a transaction open across an `await`.
   - Sleep approximately 100 ms for each step. On the first step, if the current attempt number is at most `failAttempts`, fail before recording any progress.
   - Otherwise persist each finished step. On the final step, atomically set completed status, full progress, and `input.toUpperCase()` output.
   - For simulated failure:
     - Attempts 1–2: return to queued with `available_at = now + 500 ms`, zero progress, null result/error.
     - Attempt 3: set failed with error exactly `"transient failure"`, null result, zero progress, and attempts 3.
   - Persist retry deadlines so worker restarts do not erase the delay. While one job awaits retry, other eligible jobs may run.
   - Update `updatedAt` on each job mutation; heartbeat updates must not alter job timestamps.

6. **Recover interrupted work and shut down cleanly.**
   - The task requires one worker process; recovery belongs only in worker startup, never server startup.
   - Before claiming new work, recover any persisted running job and restart its steps from zero.
   - Treat crash recovery as replay of the interrupted logical attempt: preserve its attempt number and use that number for simulated failure. This avoids consuming an extra transient retry solely because of a process interruption, particularly if attempt 3 was interrupted.
   - Keep recovered work durably running while replaying it; another crash will find it again. Completed/failed rows are never selected.
   - Recover immediately, without waiting for the old heartbeat to expire. The worker does not need server availability.
   - On SIGTERM/SIGINT, stop claiming work and stop at the next short timer boundary. Leave an unfinished job running for startup recovery, clear the heartbeat, and close SQLite after outstanding worker operations stop.
   - SIGKILL requires no cleanup: committed job updates and retry deadlines survive, while heartbeat freshness expires naturally.

7. **Build the browser page.**
   - Include every required `data-testid`, with each job item carrying its public `data-job-id`.
   - Use a textarea for input and numeric fields initialized to steps 5 and failAttempts 0.
   - Add `novalidate` to the form so browser constraints do not suppress API validation. Convert numeric field values to numbers; send empty numeric values as invalid values such as `null`, rather than silently converting them to zero or applying defaults.
   - Submit JSON to `/api/jobs`. Disable submit while the request is in flight and restore it in `finally`.
   - Clear the form-error region on a new submission; on API rejection display its message and every reported field name. Give the region `role="alert"`. Polling must not erase submission errors.
   - Fetch the job list initially, after successful submission, and approximately every 500 ms using a non-overlapping polling loop.
   - Render jobs in API order with literal status text, `completed/total`, and completed output or failed error. Leave result text empty for queued/running jobs.
   - Build DOM nodes and assign user-controlled content through `textContent`; never interpolate submitted text into HTML.
   - Keep transient polling failures from deleting the existing list, and continue polling afterward.

## Behaviours to verify
- **Build and documented commands:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The supplied checks cover only a subset of the contract.
- **Independent startup:** With a temporary database path, start server alone, worker alone, worker first, and both concurrently. Confirm directory creation, readiness within 10 seconds, and absence of SQLite lock/schema failures.
- **Health:** Confirm down without a worker, up shortly after worker startup, and down within just over 3 seconds after killing it. Verify heartbeats continue during a 20-step job.
- **Validation:** Send raw HTTP requests covering malformed/empty JSON, primitive/array/null bodies, incorrect content types, unknown fields, numeric strings, fractions, nulls, boundaries, whitespace input, and invalid keys. Check all applicable field names and unchanged job count.
- **Exact input semantics:** Submit leading/trailing whitespace, non-ASCII characters, and strings near the JavaScript length limit. Confirm storage is exact and output matches JavaScript uppercase.
- **Idempotency:** Submit omitted versus explicit defaults under one key, conflicting payloads, and parallel identical requests. Repeat after server restart. Confirm one ID and one row; requests without keys produce distinct rows.
- **Routing:** Exercise wrong methods on every known route and an unknown route. Verify JSON error codes and content types.
- **Processing:** Poll a 20-step job frequently and observe running status and intermediate progress. Confirm an idle worker claims newly queued work within 1 second and processes queued work in order.
- **Retries:** Test failAttempts 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, 3 respectively, then terminal failure at attempt 3 for the last two. Observe zero progress on failed attempts and the queued retry delay.
- **Durability:** Stop/restart both processes using the same database. Kill the worker during progress, retry waiting, and attempt 3; verify recovery within the required time and stable IDs. Confirm completed and failed jobs are never reprocessed.
- **Shutdown:** Send SIGTERM to actual Node processes and verify prompt exit without uncaught exceptions or database corruption.
- **Browser:** Exercise the required selectors, a successful job, a retrying job, terminal failure, and invalid submission. Verify automatic updates within 2 seconds, newest-first ordering, all offending field names, and literal rendering of HTML-like input.

## Risks
- **SQLite contention:** Retain the existing busy-timeout-before-WAL ordering and keep transactions synchronous and brief. Never sleep inside a transaction.
- **Attempt accounting during recovery:** Keep interrupted-attempt replay distinct from a new transient retry; document a
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
