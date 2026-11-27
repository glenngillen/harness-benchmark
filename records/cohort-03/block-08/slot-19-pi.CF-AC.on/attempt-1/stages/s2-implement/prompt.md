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
Keep the existing TypeScript entry points, npm commands, and single HTML page. Use Node.js built-ins exclusively, with SQLite holding jobs, idempotency keys, retry deadlines, and worker heartbeat state. Both processes initialize the same schema independently; the server handles validation and HTTP responses, while a sequential worker updates durable progress through short transactions. The browser polls the API and renders job data safely.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, typed row conversion, and transactional job operations.
- `src/jobs.ts`: Add shared job/payload types, validation, normalized payload comparison, and public job serialization.
- `src/server.ts`: Replace placeholder routing with the complete API, HTML serving, request handling, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat updates, sequential processing, retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Add the submission form, accessible error region, job list, polling, and modest styling.

Do not change configuration, dependency files, `TASK.md`, or `checks/`.

## Steps
1. **Define the shared contract and SQLite schema.**
   - Preserve `DATABASE_PATH` handling and parent-directory creation in `openDatabase()`.
   - Preserve the existing ordering of `busy_timeout = 5000` before enabling WAL. Use `CREATE TABLE/INDEX IF NOT EXISTS` so either process can start first.
   - Store jobs with an integer insertion sequence, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and integer `available_at` retry deadline.
   - Use the insertion sequence for deterministic ordering when creation timestamps tie: descending for listing, ascending for worker pickup.
   - Add a singleton worker heartbeat row containing the last heartbeat time in epoch milliseconds.
   - Centralize conversion from SQLite rows to the exact public job shape. Exclude internal columns; derive `progress.total` from `steps`, wrap completed output in `{ output }`, and expose null result/error in all other applicable states.
   - Use prepared statements and explicit short `BEGIN IMMEDIATE` transactions with rollback on exceptions. Never hold a transaction across an asynchronous wait.

2. **Implement complete submission validation before any database mutation.**
   - Read the request body as UTF-8 and parse JSON with caught errors.
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Require a non-null, non-array object. Empty or malformed JSON and other top-level values produce a `"body"` field error.
   - Enumerate own keys to report every unknown field. Validate all recognized fields and collect all applicable field errors instead of stopping at the first.
   - Require `input` to be a string with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Store the original string unchanged.
   - Default `steps` and `failAttempts` only when absent, never when null or another invalid value. Require actual numbers satisfying `Number.isInteger` and the specified ranges.
   - Validate an optional `Idempotency-Key` against the exact regex. Report invalid or repeated/ambiguous header values under `"Idempotency-Key"`.
   - Produce one consistent JSON error envelope; all `invalid_request` responses include `fields`, including failures involving both headers and payload.

3. **Implement atomic creation and idempotent replay.**
   - Normalize valid requests to `{ input, steps, failAttempts }` after defaults.
   - Inside one immediate transaction, look up the key if present. Compare the three stored payload fields exactly.
   - Return the existing job with HTTP 200 for an equal payload; return HTTP 409 `idempotency_conflict` for a different payload.
   - Otherwise insert a UUID job with `queued`, attempts/progress zero, null result/error, and matching initial timestamps. Enforce key uniqueness in SQLite as well as checking in application code.
   - Read the newly inserted job inside the transaction and retain that snapshot for the HTTP 201 response, so it remains `queued` even if the worker claims it immediately after commit.
   - Submissions without a key use SQL NULL and always create a fresh row.

4. **Finish HTTP routing and server lifecycle.**
   - Match URL pathname separately from method for `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`.
   - Serve the existing relative HTML location using `new URL('../ui/index.html', import.meta.url)`; this works from `dist/server.js` without copying assets.
   - Implement collection listing and individual lookup using the common serializer.
   - Return JSON 404 `not_found` for unknown paths and missing jobs. Return JSON 405 `method_not_allowed` for unsupported methods on known route patterns, with an appropriate `Allow` header.
   - `/health` always returns HTTP 200 and `status: "ok"`; report `"up"` only when a stored heartbeat is at most 3000 ms old. Do not refresh heartbeat from the server.
   - Centralize JSON response and error helpers. Catch asynchronous handler failures, avoid unhandled promise rejections, and return a JSON 500 envelope for unexpected failures when the connection permits.
   - Retain `PORT` with default 3000. On SIGTERM/SIGINT, stop accepting connections, finish active requests within a bounded grace period, close remaining connections if necessary, then close SQLite. Do not close the database while a handler can still use it.

5. **Implement the worker state machine.**
   - Initialize the schema and write a heartbeat immediately; refresh it approximately every 500 ms during idle periods, processing, and retry waits.
   - Use one asynchronous processing loop. Poll roughly every 100 ms when idle.
   - Atomically select the oldest eligible queued job (`available_at <= now`), set `running`, increment attempts, reset completed progress to zero, clear result/error, and update its timestamp.
   - For each step, await about 100 ms without blocking the event loop.
   - On the first step, if the attempt number is at most `failAttempts`, fail before incrementing progress:
     - Attempts 1–2: persist `queued`, progress zero, null result/error, and `available_at = now + 500`.
     - Attempt 3: persist `failed`, attempts 3, null result, and error exactly `"transient failure"`.
   - For successful steps, commit the completed-step count and updated timestamp separately so progress is visible.
   - On the final successful step, atomically write completed progress, status `completed`, and `input.toUpperCase()` as output.
   - During a retry delay, other eligible queued jobs may run; the delayed job remains in its original insertion order when eligible.
   - Never select completed or failed jobs.

6. **Recover interrupted work and shut down durably.**
   - On worker startup, process any persisted `running` job before selecting new queued work.
   - Replay that interrupted attempt from step zero, retaining its persisted attempt number. Treat this as recovery of the already-started attempt, not a new transient-failure retry; this avoids exceeding the three-attempt limit if the worker died during attempt 3.
   - Reset its progress and clear result/error before replay, then apply the same step and failure rules. Do not decrement attempts or alter terminal jobs.
   - Persist retry deadlines so restarting does not bypass the remaining retry delay.
   - For the specified single-worker deployment, startup recovery needs no lease-expiration wait and comfortably meets the recovery deadline.
   - On SIGTERM/SIGINT, stop claiming work and exit after the current short wait/update boundary. Leave an interrupted job durably `running` for startup recovery, stop heartbeat scheduling, clear the heartbeat, and close the database in `finally`.
   - SIGKILL requires no cleanup: committed state survives, heartbeat naturally expires, and the next worker recovers the unfinished attempt.

7. **Build the browser page.**
   - Add all required `data-testid` attributes exactly, including `role="alert"` on `form-error` and `data-job-id` on each `job-item`.
   - Use a textarea for input and numeric fields initially set to 5 and 0. Convert numeric field values to numbers in the POST body; do not use `parseInt`, which would silently turn fractions into valid integers.
   - Ensure blank numeric entries are sent as invalid values such as null rather than silently defaulted. Use `novalidate` so API validation errors can reach the required error region.
   - Clear the error region on a new submission and keep it empty after successful submission. For API rejection, display the error message plus every returned field name and message.
   - Refresh immediately on load and after submission, then poll about every 500 ms. Serialize refreshes or use a request-generation guard so stale responses cannot replace newer job state.
   - Render newest-first jobs using DOM creation and `textContent`, never interpolated user HTML.
   - Within each item, render exact status text, progress as `completed/total`, and output/error only for the corresponding terminal state.
   - Handle polling failures without destroying the last successful list; resume on the next poll. Prevent accidental duplicate form submissions while one POST is pending.

8. **Build and validate the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The existing checks cover only examples; perform the additional API, lifecycle, and browser checks below using temporary databases and the documented commands.
   - Keep any supplemental verification code under `src/` if committed; leave all fixed files unchanged.

## Behaviours to verify
- **Independent startup:** Start server first, worker first, and both together against a fresh nested database path. Both become ready within 10 seconds without schema or lock errors.
- **Health:** Server alone reports down; a live idle or busy worker reports up; SIGKILL makes it report down after the three-second freshness window.
- **Validation:** Exercise malformed/empty JSON, arrays/null/primitives, missing/wrong content type, unknown keys, absent/blank/oversized input, numeric strings, nulls, fractions, boundaries, and malformed keys. Check every offending field is named and job count stays unchanged.
- **Exact input semantics:** Submit surrounding whitespace, Unicode, and strings whose UTF-16 length differs from character count. Verify unchanged storage and JavaScript uppercase output.
- **HTTP routing:** Check all required success responses, missing IDs, unknown paths, and wrong methods, including API JSON content types and error envelopes.
- **Idempotency:** Compare omitted versus explicit defaults; vary each payload field; issue concurrent requests with the same key; restart the server and repeat. Verify one durable job per key and distinct jobs without keys.
- **Ordering and pickup:** Queue several jobs while the worker is stopped, then start it. Confirm oldest-first processing and newest-first listing, including closely timed submissions. Confirm idle pickup within one second.
- **Observable progress:** Poll a 20-step job frequently. Observe running status and increasing progress with approximately 100 ms steps; terminal progress equals total.
- **Retries:** Check `failAttempts` 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3 respectively, then failure at attempt 3 for the last two cases. Observe queued retry periods, zero progress on simulated failures, and no extra job rows.
- **Durability:** Stop and restart both processes with the same database. Preserve queued and terminal jobs, idempotency mappings, and retry deadlines.
- **Interrupted recovery:** SIGKILL the worker after observing partial progress, includin
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
