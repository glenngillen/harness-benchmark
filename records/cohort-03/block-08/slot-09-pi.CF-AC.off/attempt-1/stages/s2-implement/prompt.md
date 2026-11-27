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
Keep the existing TypeScript entry points, npm commands, and HTML location. Use SQLite as the sole communication channel, with shared schema initialization and job serialization used by both processes. The server validates and persists submissions; the worker processes one job at a time using short database transactions and asynchronous timers. The browser submits through the API and polls for updates.

## Files
- `src/db.ts`: Extend database initialization with tables, indexes, typed row conversion, and transaction helpers.
- `src/jobs.ts`: Add shared job types, validation, normalized payload comparison, and database operations.
- `src/server.ts`: Implement routing, JSON responses, submission handling, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, job claiming, observable progress, retries, restart recovery, and shutdown.
- `ui/index.html`: Implement the form, error region, job list, polling, and minimal styling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Initialize durable storage from either process.**
   - Preserve directory creation and the existing `busy_timeout` before enabling WAL.
   - Execute idempotent schema creation in a short transaction so simultaneous startup is safe.
   - Create a `jobs` table with:
     - An integer insertion sequence for deterministic ordering and a unique public ID generated with `randomUUID()`.
     - Input, steps, fail-attempt count, status, attempt count, completed-step count, nullable output/error, and ISO creation/update timestamps.
     - A nullable unique idempotency key.
     - An internal numeric `available_at` timestamp for delayed retries.
   - Create a singleton worker heartbeat table containing the latest epoch-millisecond timestamp.
   - Index queued-job lookup. Keep insertion sequence, retry scheduling, and heartbeat fields out of API responses.
   - Implement one row-to-job serializer that always returns the exact required fields, including explicit `null` values and `progress.total = steps`.

2. **Implement complete submission validation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with field `"body"`.
   - Read the request body asynchronously, catch malformed JSON, and reject `null`, arrays, and primitive values with field `"body"`.
   - For an object, collect all identifiable field errors rather than stopping at the first:
     - `input` must be a string with JavaScript length 1–1000 and nonempty `trim()`. Preserve its original contents.
     - Default `steps` and `failAttempts` only when absent; explicitly supplied `null` is invalid.
     - Require numeric integers within the specified bounds, without coercion.
     - Report every unknown own property by its name.
   - Validate any supplied `Idempotency-Key` against the exact regex, reporting `"Idempotency-Key"` on failure. Aggregate this with body errors when possible.
   - Return `400` with `invalid_request`, a useful message, and the required `fields` array. Validation must finish before any job insertion or idempotency lookup.

3. **Make creation and idempotency atomic.**
   - Normalize valid requests to the tuple `(input, steps, failAttempts)` after defaults.
   - Inside `BEGIN IMMEDIATE`, look up a supplied key. Compare the three stored values directly, avoiding JSON property-order differences.
   - Return the original job’s current representation with `200` for a matching tuple, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert one queued job with attempts/progress zero, null output/error, and equal creation/update timestamps; commit before responding `201`.
   - Capture the inserted queued representation inside the transaction. Do not reread after commit for the creation response, since the worker could already have claimed it.
   - Retain the unique key constraint as a database-level guarantee. Requests without keys store SQL `NULL` and always create distinct jobs.
   - Roll back transactions on errors; never keep a transaction open across an `await`.

4. **Complete HTTP routing and lifecycle.**
   - Classify routes by pathname before dispatching methods:
     - `/`: GET serves the existing HTML file location.
     - `/health`: GET returns JSON with worker liveness.
     - `/api/jobs`: GET lists jobs by insertion sequence descending; POST submits.
     - `/api/jobs/:id`: GET returns the job or `404 not_found`.
   - Known routes with unsupported methods return `405 method_not_allowed`; unknown paths return `404 not_found`. A missing job on the recognized item route remains a known route for method handling.
   - Use a shared JSON error helper and `application/json; charset=utf-8` for every API response and routing error.
   - Health reports `"up"` only when a persisted heartbeat exists and is no more than 3 seconds old.
   - Catch asynchronous request-handler errors so they cannot become unhandled rejections; unexpected failures use a JSON `500` response without exposing database details.
   - Preserve `PORT` defaulting to 3000 and the module-relative HTML lookup, which works from `dist/server.js`.
   - On SIGTERM/SIGINT, stop accepting connections, let active handlers finish, then close SQLite. Bound connection draining so idle or incomplete clients cannot prevent exit.

5. **Implement sequential worker processing.**
   - Initialize the same database schema, write a heartbeat immediately, and refresh it about every 500 ms while idle, processing, or awaiting retries.
   - Poll eligible queued jobs every 100 ms. Select the oldest insertion sequence with `available_at <= now`.
   - Claim in a short transaction: set `running`, increment attempts, reset completed progress to zero, clear output/error, and update the timestamp.
   - Await about 100 ms per step using Node’s asynchronous timers.
   - At the first step, if the persisted attempt number is at most `failAttempts`, fail before recording any progress.
   - Otherwise persist progress after each step. Commit the final progress, completed status, and JavaScript `input.toUpperCase()` output together.
   - Do not hold SQLite locks during processing sleeps. Process only one job at a time.

6. **Persist retry scheduling and recover interrupted work.**
   - On a simulated failure with attempts below 3, set the same job to queued, keep progress zero and output/error null, and persist `available_at = now + 500`.
   - After the third simulated failure, atomically set status failed, error exactly `"transient failure"`, result null, and attempts 3.
   - Delayed retries remain queued; the worker may process another eligible job during their delay. Choose oldest first among eligible jobs.
   - At worker startup, recover any persisted running job before claiming fresh queued work. Restart its work from step zero as continuation of its already-counted attempt, preserving the attempt number. Subsequent transient retries increment normally. This avoids creating a fourth attempt solely because a worker crashed during attempt 3.
   - Recovery must occur promptly, without waiting for the old heartbeat to expire. The specified deployment has one worker; no distributed worker leasing is necessary.
   - Completed and failed rows are never selected for processing or recovery.
   - On SIGTERM/SIGINT, stop claiming work and stop at a step boundary. Leave interrupted work durably running for startup recovery, clear the heartbeat, stop timers, and close SQLite. SIGKILL recovery follows the same persisted-state path.
   - Do not reset tables, queued retry deadlines, or terminal jobs on startup.

7. **Build the browser page against the API.**
   - Add the required test IDs: `job-form`, `job-input`, `job-steps`, `job-fail-attempts`, `job-submit`, `form-error`, and `job-list`.
   - Use a textarea for input and numeric fields defaulting to 5 and 0. Set the form to `novalidate` so browser validation does not prevent API rejection messages.
   - Submit input exactly as entered and convert numeric controls with `Number(...)`; do not use `parseInt`, which silently truncates invalid fractional input.
   - Clear the alert when starting a submission; show API rejection code/message plus every `fields[].field` and message. The `form-error` region must have `role="alert"` and otherwise remain empty.
   - Fetch the list immediately on load and after successful submission; poll approximately every 500 ms.
   - Serialize list fetches or ignore stale responses so slower earlier requests cannot overwrite newer state. Keep polling after temporary failures.
   - Render jobs newest first, each with `data-testid="job-item"` and `data-job-id`. Include status, exact `completed/total` progress, and output/error/empty text as specified.
   - Use DOM creation and `textContent` for submitted input, output, and error text. Preserve the form and focus while updating the list.

8. **Build and verify the complete contract.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The existing checks cover only selected API examples. Supplement them with local HTTP/process checks and browser inspection below, using disposable database paths.
   - Keep any added verification source under `src/` or `ui/`; do not alter the supplied checks or configuration.

## Behaviours to verify
- **Startup and configuration:** Start worker first, server first, and both simultaneously against a missing nested database directory. Confirm readiness within 10 seconds and custom/default configuration.
- **Job shape and ordering:** Submit several jobs, including rapid submissions, and inspect creation, detail, and list responses. Verify null fields, timestamps, defaults, and deterministic newest-first ordering.
- **Validation:** Exercise malformed JSON, arrays/null/primitives, missing or non-JSON content type, unknown fields, multiple simultaneous errors, whitespace-only input, length boundaries, numeric strings, fractions, null values, and invalid keys. Confirm all relevant field names and unchanged job count.
- **Idempotency:** Replay omitted versus explicit defaults, vary each payload field, issue concurrent same-key submissions, and replay after server restart. Confirm one ID per key, matching replays return 200, and conflicts create nothing.
- **Routing:** Check unsupported methods on every known route, unknown paths, and missing job IDs. Confirm JSON content types and the required error codes.
- **Progress and pickup:** Poll a 20-step job frequently. Confirm pickup within 1 second when idle, intermediate durable progress, roughly 100 ms steps, one-at-a-time processing, and final uppercase output including Unicode examples.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Confirm attempt totals 1, 2, 3, 3, and 3 respectively, zero progress on simulated failures, queued retry delays, exact terminal error, and no duplicate jobs.
- **Durability:** Stop/restart both processes using the same database. SIGKILL the worker during ordinary processing, during a retry delay, and during attempt 3. Verify prompt recovery, retained IDs/state, and no reprocessing of terminal jobs.
- **Heartbeat and shutdown:** Observe worker up while processing and idle, down within 3 seconds after SIGKILL, and clean SIGTERM exits without lingering timers/connections.
- **Browser:** Verify every required selector, numeric request values, rejection messages naming offending fields, newest-first ordering, failed/completed result text, and updates within 2 seconds without reload. Submit HTML-like text and confirm it renders as text.

## Risks
- **SQLite startup races:** Initialize schema from both processes, preserve busy timeout ordering, and use brief transactions.
- **Idempotency races:** A lookup followed by an unprotected insert is insufficient; keep both in one transaction with a unique constraint.
- **Crash accounting:** Treat replay of interrupted work a
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
