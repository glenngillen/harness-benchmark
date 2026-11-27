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
Extend the existing TypeScript entry points using only Node.js built-ins, preserving all commands and the `src/` and `ui/` layout. Put schema initialization and durable job operations in shared modules used by both processes; all communication between server and worker goes through SQLite. Use short transactions for submissions and state changes, with asynchronous timers between worker steps. Serve a small browser page that submits jobs and polls their current state.

## Files
- `src/db.ts`: Extend the existing connection setup with shared schema initialization, prepared queries, transactions, and durable worker heartbeat storage.
- `src/jobs.ts` (new): Define job and database-row types, payload validation/defaulting, job serialization, and job state operations.
- `src/server.ts`: Implement API routing, request parsing, idempotent submissions, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, heartbeat updates, retries, interrupted-job recovery, and graceful shutdown.
- `ui/index.html`: Add the submission form, error region, job list, polling, and modest styling.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define shared types and initialize SQLite from either entry point.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before enabling WAL.
   - Run idempotent `CREATE TABLE IF NOT EXISTS` initialization from `openDatabase()`, so either process can start first.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempt count, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, and retry eligibility time in epoch milliseconds.
   - Use the insertion sequence for deterministic ordering when timestamps tie: descending for listing, ascending for processing.
   - Add a singleton worker-heartbeat row containing its last-seen epoch time.
   - Use a common serializer that returns exactly the public representation. Internal scheduling, ordering, and idempotency columns must not leak into responses.
   - Keep database transactions synchronous and short; never hold one while reading HTTP bodies or awaiting timers.

2. **Implement complete submission validation before any mutation.**
   - Accept `application/json` case-insensitively, including normal parameters such as `charset=utf-8`; reject missing or other media types.
   - Read the body, parse JSON, and reject malformed JSON, `null`, arrays, and primitives with field `"body"`.
   - For objects, collect all unknown fields and all invalid recognized fields, rather than stopping at the first error.
   - Require `input` to be a string of JavaScript length 1–1000 and to have nonempty `trim()` output, but store the original string unchanged.
   - Apply defaults only to absent `steps` and `failAttempts`. Validate explicit values using their original types and `Number.isInteger`; reject `null`, numeric strings, fractions, and out-of-range values.
   - Validate a present `Idempotency-Key` against the exact required expression; an empty header is invalid. Include its field error alongside body-field errors when possible.
   - Return the required `invalid_request` envelope with a `fields` array. Invalid submissions must never reserve an idempotency key or insert a job.

3. **Make creation and idempotent replay atomic.**
   - Normalize valid input into the fixed tuple `(input, steps, failAttempts)` after applying defaults.
   - In a `BEGIN IMMEDIATE` transaction, look up any supplied key. If found, compare those three stored values exactly: return the existing job with `200`, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert a job with `crypto.randomUUID()`, status `queued`, attempts and progress zero, null output/error, immediate eligibility, and matching creation/update timestamps.
   - Retain the inserted row’s queued snapshot inside the transaction and return it with `201` after commit. Do not reread afterward: the worker might already have claimed it.
   - Enforce key uniqueness in SQLite as well as in application logic. Without a key, always insert a new row.
   - Roll back on errors. Replay returns the job’s current state, including completed or failed state.

4. **Implement HTTP routing and lifecycle.**
   - Route by URL pathname, independently of query parameters.
   - Implement `GET /health`, `POST /api/jobs`, `GET /api/jobs`, and `GET /api/jobs/:id`.
   - Health reports `up` only when a stored heartbeat is at most 3 seconds old; a missing or expired heartbeat means `down`.
   - Recognize route patterns before checking methods. Known paths with unsupported methods return `405 method_not_allowed`, preferably with `Allow`; unknown paths and missing jobs return `404 not_found`.
   - Keep errors and all API responses JSON with the required envelopes and content type. `GET /` serves HTML.
   - Preserve the existing module-relative `../ui/index.html` lookup, which works from the compiled `dist/server.js`.
   - Catch asynchronous request-handler failures so malformed requests cannot terminate the process. Return a JSON internal-error envelope for unexpected failures without exposing SQL or stack traces.
   - Retain the HTTP server handle. On `SIGTERM` or `SIGINT`, stop accepting connections, allow active handlers to finish, bound lingering connections, and close SQLite after handlers stop using it.

5. **Implement one sequential worker loop with durable scheduling.**
   - Write a heartbeat immediately on startup and refresh it approximately every 500 ms, including while idle and processing.
   - Poll approximately every 100 ms. Claim the oldest eligible queued job atomically, setting `running`, incrementing attempts, resetting progress to zero, clearing output/error, and updating its timestamp.
   - Select only jobs whose persisted retry eligibility time has arrived. A delayed retry need not block another eligible job.
   - For each step, await approximately 100 ms without a database transaction open.
   - At the first step, if the recorded attempt number is at most `failAttempts`, simulate failure before incrementing progress.
   - For an unsuccessful attempt below attempt 3, atomically return the same job to `queued`, retain its attempt count, leave progress zero and result/error null, and set eligibility to approximately 500 ms later.
   - On the third simulated failure, atomically set `failed`, error `"transient failure"`, null result, and attempts 3.
   - Otherwise persist progress after every step. Commit the final progress increment, `completed` status, and `input.toUpperCase()` output together.
   - Update `updatedAt` on every job-state mutation. Never select terminal jobs for processing.

6. **Handle process interruption explicitly.**
   - The task uses one worker process; on worker startup, inspect unfinished `running` jobs before claiming new work.
   - Recover a running job by replaying its interrupted durable attempt from step zero, retaining its recorded attempt number. Treat this as resuming the interrupted attempt, so process crashes do not consume simulated-failure retries or produce a fourth logical attempt.
   - Apply the same first-step failure rule to that recorded attempt. Subsequent retries increment attempts normally.
   - Persist the recovery reset before processing. Recover immediately on startup, comfortably within the recovery deadline, without relying on server activity or an in-memory timer.
   - Persist retry deadlines so queued retries also survive either process restarting.
   - On worker termination, stop claiming work, cancel or finish the short current wait, and leave any interrupted job durably `running` for recovery. Clear the heartbeat, stop timers, then close SQLite.
   - After `SIGKILL`, rely on committed SQLite state and heartbeat expiration; no cleanup handler is assumed to run.

7. **Build the browser page around the API contract.**
   - Include all specified `data-testid` attributes, with `form-error` carrying `role="alert"` and each `job-item` carrying `data-job-id`.
   - Initialize numeric inputs to 5 and 0. Submit their values as JavaScript numbers and the input string unchanged.
   - Use `novalidate` on the form so native constraints do not suppress submissions that should receive API validation errors. Do not silently replace an emptied numeric field with its default; send an invalid value such as `null`.
   - Clear the error region when starting a submission. On API rejection, show its message and every returned offending field name. Preserve entered values on failure.
   - Refresh the list immediately after submission and approximately every 500 ms, rendering the API’s newest-first order.
   - Prevent overlapping list refreshes or discard stale responses so an older response cannot overwrite newer state.
   - Render status, `completed/total`, and completed output or failed error exactly as required; leave result text empty for queued/running jobs.
   - Use DOM construction and `textContent` for all submitted text, output, and errors. Keep the form stable while updating job rows.

8. **Build and verify without changing fixed files.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with temporary external scripts or manual requests and browser checks. The existing contract suite does not cover browser behavior, restart durability, or the full validation matrix.
   - Use isolated temporary database paths and available ports for lifecycle tests, and terminate both processes afterward.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both concurrently using a nested missing database directory and a nondefault port; confirm readiness within 10 seconds.
- **Health:** Check `down` without a worker, `up` while idle and busy, and `down` within slightly more than 3 seconds after killing the worker.
- **Job shape and ordering:** Submit multiple jobs without a worker; verify queued responses, defaults, timestamps, null fields, exact input preservation, unique IDs, and deterministic newest-first listing.
- **Validation:** Exercise every rule, including multiple simultaneous field errors, whitespace-only input, 1000/1001-character boundaries, numeric strings, explicit nulls, unknown fields, malformed JSON, arrays, missing content type, and invalid keys. Confirm the job count does not increase.
- **Idempotency:** Compare omitted and explicit defaults, run concurrent submissions with one key, change each normalized field separately, and replay after server restart. Verify one durable job and the correct `200`/`409` responses.
- **Routing:** Check unsupported methods on every known route, nonexistent IDs, unknown paths, and JSON error content types.
- **Processing:** Poll a 20-step job frequently enough to observe `running` and intermediate progress. Check pickup latency, step timing, exact JavaScript uppercase output, and terminal field consistency.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify attempt counts 1, 2, 3, 3, and 3 respectively, observable queued retry delays, zero progress on simulated failures, and no duplicate jobs.
- **Durability:** Stop and restart both processes with queued, retry-waiting, completed, and failed jobs present. Kill a worker mid-attempt, including during a successful third attempt, then verify recovery and unchanged terminal jobs.
- **Browser:** Submit valid and rejected forms; inspect all required selectors, field names in alerts, automatic progress updates within 2 seconds, final output/error text, and safe rendering of HTML-like input.
- **Shutdown:** Send `SIGTERM` while idle and busy; confirm prompt process exit, no unhandled errors, and intact database state.

## Risks
- **Attempt recovery ambiguity:** Distinguish resuming an interrupted durable attempt from st
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
