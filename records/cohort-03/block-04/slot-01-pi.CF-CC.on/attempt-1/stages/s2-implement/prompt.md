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
Implement the API and worker with Node.js built-ins and a shared SQLite database, retaining the existing entry points and commands. Put schema initialization and job serialization in shared modules so either process can start first. Use short transactions for submission, claiming, and state transitions; persist retry deadlines and heartbeat timestamps. Serve a dependency-free browser page that submits JSON and polls for updates.

## Files
- `src/db.ts`: Extend the existing database opener with idempotent schema initialization, transaction helpers, and typed database operations. Preserve parent-directory creation and `busy_timeout` before WAL initialization.
- `src/jobs.ts` (new): Define payload/job types, validation, normalized payload comparison, and the public job serializer.
- `src/server.ts`: Implement routing, body parsing, validation, idempotent submission, job reads, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, durable retries, interrupted-attempt recovery, heartbeat updates, and graceful shutdown.
- `ui/index.html`: Add the required form, error region, job list, and polling script.
- Leave configuration, dependencies, commands, and `checks/` unchanged.

## Steps
1. **Define the persistent model and public representation.**
   - Create tables with `CREATE TABLE IF NOT EXISTS` from the shared database initializer.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, failure simulation count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric retry eligibility timestamp.
   - Generate public IDs with `node:crypto.randomUUID()`. Use the insertion sequence for deterministic newest-first listing and oldest-first selection, including jobs created in the same millisecond.
   - Store the worker heartbeat in a singleton row with an epoch-millisecond timestamp.
   - Serialize every returned job through one function: expose only the specified fields, derive `progress.total` from `steps`, return `{output}` only for completed jobs, and return an error only for failed jobs.
   - Use parameterized statements. Keep transactions synchronous, with rollback on exceptions; never hold a transaction across a timer or request-body read.

2. **Implement comprehensive submission validation.**
   - Read the complete request body before parsing; catch malformed JSON and request stream errors without allowing unhandled promise rejections.
   - Accept media type `application/json` case-insensitively, allowing parameters such as `charset=utf-8`; missing or other media types produce a `"body"` error.
   - Require a non-null, non-array JSON object. For a valid object, collect all field violations instead of stopping after the first.
   - Enumerate own properties to reject every unknown field. Check presence explicitly so omitted optional values receive defaults, while explicit `null`, strings, and other wrong types fail.
   - Validate `input` using JavaScript `.length` and `.trim()` without changing the stored value. Require numeric integer ranges for the other two fields.
   - Validate a present `Idempotency-Key` against the exact required expression; an empty or repeated/comma-joined header is invalid. Include its field error alongside body-field errors where available.
   - Return `400` with `error.code = "invalid_request"`, a useful message, and the complete `fields` array. Perform no writes until validation succeeds.

3. **Implement atomic creation and idempotency.**
   - Normalize successful validation to `{input, steps, failAttempts}` with defaults applied.
   - In a short `BEGIN IMMEDIATE` transaction, look up a supplied key. Compare the three normalized values directly with the original job’s immutable submission values.
   - Return the original job’s current representation with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert one queued job with zero attempts/progress and null output/error. Capture its initial public representation in the transaction, commit, then return it with `201`; do not reread after commit, when the worker could already have claimed it.
   - Enforce uniqueness in SQLite as well as application logic. Bind absent keys as SQL `NULL`, allowing every unkeyed submission to create a job.
   - Keep keys and original payload values permanently, including for terminal jobs.

4. **Complete HTTP routing and process lifecycle.**
   - Recognize `/`, `/health`, `/api/jobs`, and exactly one ID segment after `/api/jobs/`. Match paths before checking methods so known paths return `405` and unknown paths return `404`.
   - Support GET for `/`, `/health`, and individual jobs; support GET and POST for `/api/jobs`. Optionally include an `Allow` header with `405`.
   - Return the required JSON error envelope for API errors, missing jobs, unknown paths, and wrong methods. Use a common JSON response helper with `application/json; charset=utf-8`.
   - Read health directly from SQLite: missing or older-than-three-seconds heartbeat means `"down"`; a fresh heartbeat means `"up"`.
   - Preserve the existing HTML file lookup relative to `import.meta.url`, which works from `dist/server.js`. Only the successful page response uses HTML content type.
   - Catch asynchronous handler failures and return a JSON `500` without exposing database internals.
   - Retain the server handle. On SIGTERM/SIGINT, stop accepting requests, finish active handlers, close connections as needed within a bounded shutdown period, then close SQLite. Avoid closing the database while a handler still uses it.

5. **Implement sequential worker processing and heartbeat.**
   - Initialize the schema and write a heartbeat immediately. Refresh it every approximately 500 ms while idle, processing, or waiting for retry eligibility.
   - Poll approximately every 100 ms. In a short transaction, select the oldest eligible queued job, set it to running, increment attempts, reset progress, clear output/error, and update its timestamp.
   - Process only one job at a time. Sleep asynchronously for approximately 100 ms before each step, allowing heartbeat timers to run.
   - If the attempt number is at most `failAttempts`, fail after the first step’s delay but before incrementing progress.
   - Otherwise persist each completed step separately. Commit the final progress value and completed status/output together, using JavaScript `input.toUpperCase()`.
   - On simulated failure before attempt three, persist status `queued`, zero progress, null output/error, and a retry deadline 500 ms in the future. On the third simulated failure, persist status `failed`, error `"transient failure"`, and null output.
   - Select queued jobs by insertion order among jobs whose retry deadline has arrived. Waiting retries must not make newly submitted eligible jobs wait for an unnecessary sleep.
   - Update `updatedAt` on every job state/progress transition; leave `createdAt` unchanged.

6. **Recover durable work and shut down safely.**
   - On worker startup, inspect persisted running jobs before taking new queued work. The task uses one worker process; recovery belongs to the worker, never server startup.
   - Treat a persisted running job as an interrupted, unfinished attempt: reset its progress and rerun that durable attempt from its first step, retaining its attempt number. This avoids manufacturing a fourth retry when a worker dies during attempt three; subsequent simulated failures follow the normal retry rules.
   - Persist retry deadlines so restarting cannot erase the required delay. An overdue retry is immediately eligible.
   - Never reset or select completed/failed jobs. Do not clear the database during initialization.
   - On SIGTERM/SIGINT, set a stopping flag and stop claiming jobs. Check it after each short sleep and leave unfinished work durably running for recovery. Clear heartbeat timers, clear the heartbeat row, close SQLite, and exit naturally.
   - For SIGKILL, rely on committed state and heartbeat expiry. Recover interrupted work immediately on the next worker startup, comfortably inside the ten-second recovery allowance.

7. **Build the browser page.**
   - Add a form with `job-form`, input controls with `job-input`, `job-steps`, and `job-fail-attempts`, and a `job-submit` button. Initialize numeric controls to 5 and 0.
   - Add an always-present, initially empty `form-error` region with `role="alert"`, plus `job-list`.
   - Use `novalidate` so native constraints do not prevent the API from returning required validation errors. Send the input unchanged and numeric values as JSON numbers; avoid `parseInt`, which would silently truncate decimals or accept partial strings. Send empty/unparseable numeric entries as an invalid value such as `null`, not as an accidental default.
   - On submission, clear stale errors and POST JSON. For rejection, display the server message and every offending field name/message using text nodes. Leave the error region empty after successful submission.
   - Fetch the list initially, immediately after successful submission, and approximately every 500 ms. Serialize refreshes or discard stale responses so older responses cannot overwrite newer state.
   - Render newest-first items with `job-item` and `data-job-id`, containing the required status, `completed/total` progress, and result/error elements. Keep result text empty for queued/running jobs.
   - Use `textContent` for submitted input, results, and error messages. Keep form controls outside the refreshed list so polling preserves typed values and focus.

## Behaviours to verify
- **Existing commands:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The existing suites create isolated databases and launch both processes; they do not cover the whole task.
- **Startup/configuration:** Start server first, worker first, and both together against a fresh nested `DATABASE_PATH`. Verify readiness within ten seconds and the default configuration.
- **Validation:** Exercise malformed/empty JSON, arrays, null, missing/non-JSON content type, unknown fields, numeric strings, fractions, limits, whitespace-only input, and invalid keys. Combine several violations and verify all offending fields appear and job count does not change.
- **Exact values:** Submit surrounding whitespace, Unicode, and boundary-length strings. Confirm input preservation, JavaScript string-length validation, and JavaScript uppercase output.
- **Routes:** Check unknown paths, unsupported methods on every known path, missing IDs, response status codes, and JSON error content types.
- **Idempotency:** Replay a key with omitted versus explicit defaults, change each payload field, issue simultaneous matching submissions, and restart the server. Verify one ID/job per key and a new job for every unkeyed submission.
- **Scheduling/progress:** Queue several jobs without a worker, then start it. Poll a 20-step job frequently enough to observe intermediate progress and confirm FIFO selection, sequential execution, and prompt idle pickup.
- **Retries:** Check `failAttempts` 0, 1, 2, 3, and 5. Verify attempt counts, zero progress on simulated failures, observable queued retry delays, completion on attempt three for 2, and the exact terminal error for 3 or more.
- **Durability:** Stop and restart both processes using SIGTERM and SIGKILL against the same file. Include queued, running, retry-waiting, completed, and failed jobs; kill during the third attempt too. Verify preserved IDs, recovery, and no terminal reprocessing.
- **Health/shutdown:** Verify worker-down before startup, up during long work/retries, down within three seconds after SIGKILL, and clean SIGTERM exit without lingering timers or locked database handles.
- **Browser:** Submit successful and invalid forms, confirm every required test ID and field-level rejection, observe u
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
