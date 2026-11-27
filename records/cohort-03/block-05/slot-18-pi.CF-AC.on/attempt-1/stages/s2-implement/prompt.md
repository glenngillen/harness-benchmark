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
Extend the existing TypeScript server, worker, and database helper using only Node.js built-ins. Store jobs, idempotency keys, retry deadlines, and worker heartbeats in SQLite; use short transactions so HTTP requests and worker updates can run concurrently. Keep processing asynchronous with persisted progress after every step, and serve a plain HTML/JavaScript page that polls the API. Preserve the existing commands, configuration defaults, and file layout.

## Files
- `src/db.ts`: Extend database initialization with schema, prepared queries, transactions, job serialization, and durable worker state.
- `src/jobs.ts`: Add shared job types and submission validation/default normalization.
- `src/server.ts`: Implement routing, JSON request handling, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement job selection, processing, retries, heartbeat updates, recovery, and graceful shutdown.
- `ui/index.html`: Implement the submission form, validation error display, job list, and polling.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the public model and validation.**
   - Define the exact public job representation separately from internal database columns.
   - Validate parsed JSON as a non-null, non-array object.
   - Collect all offending fields, including unknown keys. Use own-property checks to distinguish omitted fields from explicitly supplied invalid values.
   - Require `input` to be a string with JavaScript `.length` between 1 and 1000 and a nonempty `.trim()`. Store its original value.
   - Default omitted `steps` to 5 and omitted `failAttempts` to 0. Require actual numbers satisfying `Number.isInteger()` and the specified ranges.
   - Validate any supplied `Idempotency-Key` against the exact regex, including rejecting an empty value.
   - Normalize valid payloads to a fixed property order before serializing them for idempotency comparison.

2. **Initialize durable storage from either process.**
   - Preserve the existing directory creation and `busy_timeout`-before-WAL initialization.
   - Create schema with `CREATE TABLE IF NOT EXISTS`, safely supporting simultaneous server and worker startup.
   - Store jobs with:
     - An integer insertion sequence for deterministic ordering.
     - A unique public ID generated with `randomUUID()`.
     - Input, steps, failure configuration, status, attempts, completed steps, output, error, and ISO timestamps.
     - An internal `available_at` timestamp for retry eligibility.
     - A nullable unique idempotency key and normalized payload string.
   - Add a worker-state table containing its last heartbeat timestamp.
   - Index job selection by status/eligibility and insertion sequence.
   - Centralize serialization so every endpoint returns exactly the required shape. Never expose internal columns; construct `result` only for completed jobs and `error` only for failed jobs.
   - Provide a synchronous transaction helper using `BEGIN IMMEDIATE`, `COMMIT`, and rollback on error. Never hold a transaction across an `await`.

3. **Implement HTTP routing and request handling.**
   - Retain the existing UI file resolution relative to `import.meta.url`; it works from both the source and compiled layout.
   - Match paths first, then methods:
     - `/`: GET serves HTML.
     - `/health`: GET returns JSON health.
     - `/api/jobs`: GET lists jobs, POST submits.
     - `/api/jobs/:id`: GET retrieves one job.
   - Return JSON `405 method_not_allowed` for unsupported methods on these paths, and JSON `404 not_found` for unknown paths or missing jobs. Extra path segments must not match a job route.
   - Use one JSON response helper and one structured error helper.
   - For submissions, accept the `application/json` media type case-insensitively, including parameters such as `charset=utf-8`. Reject absent or other media types with field `"body"`.
   - Read the complete request before parsing JSON. Report malformed JSON and non-object bodies with field `"body"`, and combine independently detectable header/body validation errors where possible.
   - Catch request failures and handler exceptions without crashing the server or generating unhandled promise rejections.
   - List jobs by insertion sequence descending; worker ordering uses ascending sequence.

4. **Make job creation and idempotency atomic.**
   - Complete validation before accessing or creating an idempotency record.
   - Within one immediate transaction, look up a supplied key:
     - Equal normalized payload: return the original job’s current representation with `200`.
     - Different payload: return `409 idempotency_conflict`.
     - Absent key: insert a queued job with attempts/progress zero, null result/error, and matching initial timestamps.
   - Keep the key and payload in the job row so their persistence is atomic with creation. Enforce key uniqueness in SQLite, not only in application logic.
   - Return the inserted queued snapshot with `201`. Capture it before committing/releasing the transaction so a fast worker cannot change the creation response to `running`.
   - Submissions without a key always insert a new row.

5. **Implement the worker loop and heartbeat.**
   - Write a heartbeat immediately after initialization and approximately every 500 ms, including during processing and retry waits.
   - `/health` reports `"up"` only when the stored heartbeat is at most 3000 ms old. The server never writes worker liveness.
   - Poll for work every 100 ms when idle.
   - Atomically select and claim the oldest eligible queued job using an immediate transaction. Eligibility requires `available_at <= now`; a delayed retry must not prevent other eligible jobs from running.
   - Claiming a new attempt sets `running`, increments attempts, resets progress to zero, clears result/error, and updates `updatedAt`.
   - Process only one job at a time. Await about 100 ms per step, then commit that step’s progress.
   - On the final successful step, atomically store full progress, `completed`, and JavaScript `input.toUpperCase()` as the output.
   - Update `updatedAt` on every job state/progress change.

6. **Implement transient failures and persisted retry delays.**
   - After the first step’s approximately 100 ms delay, check whether the attempt number is at most `failAttempts`. If so, fail before incrementing progress.
   - For failed attempts 1 and 2, set status back to `queued`, keep attempts unchanged, keep progress at zero and result/error null, and persist `available_at = now + 500 ms`.
   - After the third transient failure, atomically store `failed`, attempts 3, progress zero, null result, and error `"transient failure"`.
   - Reuse the same job row throughout; never create result or retry jobs.
   - Do not implement retry waiting solely with an in-memory timer: restarting must preserve the remaining delay.

7. **Handle restart recovery and shutdown explicitly.**
   - On worker startup, recover any `running` job before selecting ordinary queued work. Recovery must be performed only by the worker, never by the server.
   - Treat an interrupted durable attempt as unfinished: replay it from step zero using its existing attempt number. Preserve the count already incremented when that attempt was claimed; normal transient retries still increment on their next claim.
   - This recovery policy avoids consuming extra transient retry budget merely because a process crashed, including when a successful third attempt was interrupted. Keep this distinction explicit in code comments.
   - Persist the reset progress before replaying. Leave completed and failed rows untouched.
   - On worker SIGTERM/SIGINT, stop accepting new work, interrupt processing at a step boundary, leave unfinished work recoverable, stop the heartbeat, clear its liveness record, and close SQLite.
   - On server SIGTERM/SIGINT, stop listening, allow active handlers to finish, close idle connections, and close SQLite after handlers finish. Bound shutdown if clients retain incomplete requests.
   - Do not force process exit before synchronous database writes finish. SIGKILL recovery must rely entirely on committed SQLite state.

8. **Build the browser page.**
   - Add all required `data-testid` attributes exactly as specified, plus labels and sensible defaults of 5 steps and 0 failed attempts.
   - Use a form with `novalidate` so browser constraints do not prevent API validation errors from reaching the required alert region.
   - Submit the input unchanged and convert numeric field values to numbers. Represent empty/invalid numeric values as invalid JSON values such as `null`, rather than accidentally defaulting them or converting blank failure counts to valid zero.
   - Send JSON with the correct content type. Disable the submit button while a request is pending.
   - Clear `form-error` on a new submission and after success. On API rejection, show its message and every field name/message using `textContent`.
   - Render jobs newest first, with each required child element inside its `job-item` and `data-job-id` set.
   - Display exact status text, `completed/total`, completed output, or terminal error as required.
   - Fetch the list immediately on load, after successful submission, and about every 500 ms. Serialize refreshes or discard stale responses so an older request cannot overwrite newer state.
   - Keep polling after temporary fetch failures without overwriting submission validation errors.
   - Use DOM creation and `textContent` for submitted text and results to avoid HTML injection.

## Behaviours to verify
- **Existing commands and startup:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The inspected checks cover only examples, so continue with the scenarios below.
- **Configuration and process independence:** Start each process first in separate trials, using the same temporary `DATABASE_PATH` with a missing parent directory and a nondefault port. Confirm readiness within 10 seconds.
- **Validation completeness:** Submit malformed JSON, arrays, null, missing/wrong content types, whitespace-only input, input length boundaries, numeric strings, fractions, null fields, out-of-range numbers, unknown keys, and invalid idempotency keys. Confirm every relevant field is listed and job count is unchanged.
- **Routing and representation:** Exercise all endpoints, unknown paths, missing IDs, and unsupported methods. Check JSON content types, error codes, exact public fields, ISO timestamps, and newest-first ordering even for rapidly created jobs.
- **Idempotency durability:** Replay omitted versus explicit defaults; vary each payload field; send concurrent requests with one key; restart the server and replay again. Confirm one job and the correct `200`/`409` responses. Confirm unkeyed identical submissions create separate jobs.
- **Observable processing:** Submit a 20-step job and poll every 25–50 ms. Confirm pickup within 1 second when idle, running state, incremental progress at approximately 100 ms intervals, and correct uppercase output, including Unicode input.
- **Retries:** Exercise `failAttempts` 0 through 5. Confirm attempts 1/2/3 for eventual successes, terminal failure at 3 for values 3–5, zero progress on failed attempts, and queued delays between 250 ms and 2 seconds.
- **Health:** Confirm `"up"` during a long job and while idle; terminate or kill the worker and confirm `"down"` no later than heartbeat expiry.
- **Durability:** Restart both processes against the same database after SIGTERM and SIGKILL. Include queued, running, retry-waiting, completed, and failed jobs. Confirm terminal jobs remain unchanged, interrupted work recovers promptly, and idempotency mappings survive.
- **Recovery edge case:** Kill a `failAttempts: 2`, 20-step job during its third attempt; restart and confirm it completes without duplicating the job or incorrectly failing due to the crash.
- **Browser:** Ver
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
