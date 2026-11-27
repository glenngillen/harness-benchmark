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
Extend the existing TypeScript entry points using only Node.js built-ins and retain all current commands. Put schema initialization, job serialization, and transactional state changes in a shared SQLite module used independently by the server and worker. Use short database transactions, asynchronous worker timers, durable retry deadlines, and a database heartbeat. Build the browser interface in the existing HTML file with API polling.

## Files
- `src/db.ts`: Extend database initialization; add schema, typed row conversion, queries, and transactional job operations.
- `src/jobs.ts`: Add public job/payload types and request validation helpers.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, progress, retries, heartbeat, restart recovery, and shutdown.
- `ui/index.html`: Implement the submission form, job list, error reporting, and polling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Define the shared data contract and schema.**
   - Preserve `openDatabase()`’s parent-directory creation and `busy_timeout` before WAL initialization. Both entry points must initialize the same schema with `CREATE TABLE IF NOT EXISTS`, so either process can start first.
   - Create a jobs table with an insertion sequence (`INTEGER PRIMARY KEY AUTOINCREMENT`), unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and retry eligibility timestamp in epoch milliseconds.
   - Use insertion sequence for deterministic ordering when jobs share a timestamp: descending for listing, ascending for processing.
   - Create a singleton heartbeat table storing the worker’s last-seen epoch milliseconds.
   - Add one serializer that exposes exactly the required job shape, excluding internal sequence, key, and retry deadline. Use `steps` for `progress.total` and expose output as `{ output }` only for completed jobs.
   - Use prepared statements and parameter binding throughout. Wrap multi-statement mutations in synchronous `BEGIN IMMEDIATE`/`COMMIT`, with rollback on exceptions; never hold a transaction across an `await`.

2. **Implement complete submission validation before any database mutation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Read the request body, catch malformed/empty JSON, and reject null, arrays, and primitives with a `"body"` field error.
   - For objects, collect all offending fields, including every unknown own property.
   - Require string input with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Preserve the original string exactly.
   - Apply numeric defaults only when properties are absent. Require actual numbers, `Number.isInteger`, and the specified ranges; reject numeric strings, null, and booleans.
   - Validate a present `Idempotency-Key` against the exact regex; an empty value is invalid, not an omitted key. Reject duplicate header values rather than silently choosing one.
   - Include header validation errors alongside body/field errors where ascertainable. Return `400 invalid_request` with a message and required `fields` array.

3. **Implement atomic creation and durable idempotency.**
   - Generate IDs with `randomUUID()` from `node:crypto`.
   - Inside one immediate transaction, look up a supplied key. Compare the stored immutable `input`, `steps`, and `failAttempts` against the validated payload after defaults.
   - Return the current original job with `200` for equal payloads or `409 idempotency_conflict` for differences.
   - Otherwise insert one queued job with zero attempts/progress, null output/error, and equal initial timestamps. Enforce uniqueness of non-null keys in SQLite; multiple null keys must remain allowed.
   - Capture the inserted queued representation before committing and return it with `201`. Do not re-read after committing, because the worker may already have changed the status.
   - Ensure invalid requests and conflicts insert nothing.

4. **Complete HTTP routing and lifecycle.**
   - Match paths before checking allowed methods: `/` permits GET, `/health` permits GET, `/api/jobs` permits GET/POST, and `/api/jobs/:id` permits GET.
   - Return JSON `405 method_not_allowed` for wrong methods on these paths, optionally with `Allow`; unmatched paths return JSON `404 not_found`. GET for an absent job also returns `404 not_found`.
   - Use URL pathname matching so query strings do not alter routes. Safely handle malformed URLs/encoded IDs without crashing.
   - Return lists newest first and individual jobs through the shared serializer.
   - `/health` returns `worker: "up"` only when a stored heartbeat is at most 3000 ms old; absent/stale heartbeat means `"down"`. The server must never write worker heartbeats.
   - Preserve serving `ui/index.html` through the existing module-relative path, which also works from `dist/server.js`.
   - Centralize JSON responses and structured errors, and catch asynchronous request-handler failures.
   - Retain `PORT` default 3000. On SIGTERM/SIGINT, stop accepting requests, allow active handlers to finish, then close SQLite. Bound shutdown of stalled connections so shutdown cannot hang indefinitely.

5. **Implement sequential worker processing and observable progress.**
   - Write a heartbeat immediately after initialization and every approximately 500 ms while idle, processing, or waiting between attempts.
   - Poll for eligible queued work every 100 ms. Select the oldest queued job whose persisted retry deadline has passed.
   - Claim it atomically: set running, increment attempts, reset progress to zero, clear result/error, and update its timestamp.
   - Execute only one job at a time. Await approximately 100 ms per step using asynchronous timers, then persist the completed-step count and update timestamp.
   - On a successful last step, atomically set completed progress, completed status, and `input.toUpperCase()` output. Use JavaScript uppercase conversion, not SQLite’s `upper()`.
   - Never select completed or failed jobs.

6. **Implement failures, delayed retries, and recovery.**
   - After the first step’s approximately 100 ms delay, if the current attempt number is at most `failAttempts`, fail before incrementing progress.
   - For attempts 1 and 2, atomically return the job to queued with zero progress, null result/error, and a retry deadline approximately 500 ms in the future.
   - On attempt 3 failure, atomically mark failed with exactly `"transient failure"`, null result, and zero progress. Never create a replacement job.
   - Persist retry deadlines so a worker restart does not erase the retry delay.
   - At worker startup, recover any running job before taking new queued work. Resume the interrupted logical attempt from step zero, preserving its already-incremented attempt number; apply the same failure rule to that attempt. This prevents a crash during attempt 3 from introducing attempt 4 or incorrectly failing a job that would succeed.
   - Persist the recovery progress reset and timestamp. Keep terminal rows untouched. With the specified single worker process, recovery can begin immediately without waiting for heartbeat expiration.
   - On SIGTERM/SIGINT, stop claiming work and finish or interrupt the current short timer. If interrupted, leave the running job recoverable; clear heartbeat/timers and close SQLite only after the loop stops. Abrupt termination relies on committed SQLite state and heartbeat expiration.

7. **Implement the browser page.**
   - Add every required `data-testid` exactly as specified, including `role="alert"` on `form-error`.
   - Initialize steps to 5 and fail attempts to 0. Preserve input text exactly; convert numeric field strings with `Number`, treating blanks as invalid values rather than accidentally converting an empty fail-attempt field to valid zero.
   - Use `novalidate` so native required/range validation does not prevent API validation and its field errors from reaching the alert.
   - POST JSON with the correct content type. Disable submit during the request and restore it in `finally`.
   - Clear prior errors for a new submission; show the API rejection message and every returned offending field name. Keep errors visible until another submission clears/replaces them; background polling must not clear them.
   - Fetch the list on load, immediately after successful submission, and approximately every 500 ms. Serialize list refreshes or guard responses against stale rendering.
   - Render newest first, with one `job-item` carrying `data-job-id` per job, status text, exact `completed/total` progress, and output/error only in the appropriate terminal state.
   - Render user input, results, and errors with DOM `textContent`, avoiding HTML interpolation. Keep polling after transient fetch failures.

8. **Build and verify the full contract.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The existing checks cover only startup and selected API examples. Exercise the additional cases below using temporary databases, separate server/worker processes, HTTP requests, and a browser.
   - Confirm the implementation diff changes only files under `src/` and `ui/`.

## Behaviours to verify
- **Independent startup and configuration:** Start worker-first, server-first, and simultaneously using a nested missing database directory and a nondefault port; both become ready within 10 seconds.
- **Health:** Start only the server and observe `"down"`; start the worker and observe `"up"`. Kill the worker and verify `"down"` after heartbeat expiration.
- **Validation:** Exercise malformed JSON, empty body, arrays/null/primitives, wrong/missing content type, unknown fields, missing/blank/oversized input, numeric strings, fractions, nulls, and range boundaries. Submit several errors together and verify every offending field appears and the job count stays unchanged.
- **Input preservation:** Submit whitespace-surrounded text and Unicode, including characters whose uppercase expands; verify stored input and JavaScript uppercase output exactly.
- **Routing:** Check unknown paths, missing IDs, and wrong methods on each known route; verify status codes, JSON content type, and error shape.
- **Idempotency:** Replay omitted versus explicit defaults, issue concurrent same-key requests, change each payload field, restart the server, then replay again. Verify one ID/row per key and independent jobs without keys.
- **Ordering and progress:** Queue several jobs while the worker is stopped, then start it. Verify oldest-first claims, newest-first listing, single-job execution, pickup within one second, and intermediate progress on a 20-step job.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify attempt counts 1, 2, 3, 3, and 3; queued delays within 250–2000 ms; zero failed-attempt progress; and the exact terminal error.
- **Durability:** Stop and restart both processes on the same database. Kill the worker during processing, during attempt 3 of a success-after-retries job, and while a retry is queued. Verify recovery, retained deadlines, unchanged job IDs, and no reprocessing of terminal jobs.
- **Shutdown:** Send SIGTERM to each actual Node process; verify prompt clean exit and no database-use-after-close errors.
- **Browser:** Submit valid and invalid forms, confirm numeric JSON values and visible field names, and watch status/progress/result update within two seconds without reload. Reload the page and verify durable jobs remain visible.

## Risks
- **SQLite contention and startup races:** Preserve busy-timeout-before-WAL ordering and keep write transactions short; never sleep while holding a transa
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
