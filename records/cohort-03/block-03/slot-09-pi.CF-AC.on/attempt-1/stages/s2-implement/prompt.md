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
Keep the existing TypeScript entry points, npm commands, and HTML location. Use `node:sqlite` for all shared state, with short transactions for job creation, claims, retries, and completion. Run one asynchronous processing loop in the separate worker, with database heartbeats independent of job availability. Serve a dependency-free browser page that submits through the API and polls for changes.

## Files
- `src/db.ts`: Extend database initialization with schema, indexes, transactions, and typed job persistence helpers.
- `src/jobs.ts` (new): Define public job types, payload validation, normalized payload comparison, and row-to-JSON mapping.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health checks, and shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, delayed retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Add the required form, job list, error display, polling, and modest inline styling.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Initialize shared durable storage from either process.**
   - Preserve directory creation, `busy_timeout` before WAL initialization, and the configured/default database path.
   - Use `CREATE TABLE/INDEX IF NOT EXISTS` so either process can initialize an empty database.
   - Store jobs with an insertion sequence, unique public UUID, input, steps, fail-attempt count, status, attempts, completed-step count, nullable output/error, ISO timestamps, and numeric `available_at`.
   - Store an optional unique idempotency key on the job row. SQLite permits multiple `NULL` values, allowing unrestricted unkeyed submissions.
   - Add a singleton heartbeat row with the worker’s last-seen epoch milliseconds.
   - Index queued work by status, availability, and insertion order. Use insertion sequence descending for listing and ascending for eligible queued work, avoiding timestamp ties.
   - Use prepared statements and a transaction helper that rolls back on failure. Never hold a transaction across a timer or HTTP body read.

2. **Centralize representation and validation.**
   - Map database rows to exactly the public job shape; never expose scheduling, sequence, or idempotency columns.
   - Derive `progress.total` from `steps`; expose output only for completed jobs and error only for failed jobs.
   - Validate parsed data as a non-null, non-array object. Reject every unknown own property.
   - Require a string input with JavaScript length 1–1000 and nonempty `trim()`, but preserve the original string.
   - Apply numeric defaults only when fields are absent. Reject `null`, strings, booleans, fractions, and out-of-range values; use `Number.isInteger`.
   - Accumulate field errors rather than stopping at the first invalid property.
   - Validate any present idempotency key against the exact regex, including rejecting an empty value.
   - Compare normalized submissions by the three validated values, preserving input whitespace and case.

3. **Implement the HTTP contract.**
   - Read the existing HTML through the module-relative path, which works from `dist/server.js`.
   - Match pathname independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and exactly one ID segment under `/api/jobs/`.
   - Dispatch allowed methods after matching the route: unknown routes return JSON `404 not_found`; unsupported methods on recognized routes return JSON `405 method_not_allowed`, optionally with `Allow`.
   - Serve `/` as HTML. Use a common JSON response/error helper for all API and routing responses.
   - For submission, accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` validation error.
   - Collect request chunks and decode UTF-8 once before parsing. Empty or malformed JSON and non-object JSON produce `"body"` errors. Include independently detectable key/body-field errors in the same validation response.
   - Validate before performing any database mutation or idempotency lookup.
   - Inside `BEGIN IMMEDIATE`, look up the key if supplied. Return the existing job with `200` when normalized values match, or `409 idempotency_conflict` otherwise. If absent, insert one UUID-assigned queued job and commit.
   - Build the `201` response from the inserted queued snapshot inside that transaction, so a fast worker cannot change the creation response to `running`.
   - Implement list and detail reads through the same serializer; missing IDs return `404`.
   - `/health` reports `up` only when a stored heartbeat is no more than 3 seconds old; missing/stale heartbeat means `down`.
   - Catch request-handler failures so malformed requests cannot crash the process. Unexpected failures return a structured JSON server error without exposing SQL details.

4. **Implement sequential processing and retries.**
   - Write an immediate heartbeat on worker startup and refresh it approximately every 500 ms while idle, processing, or waiting for retries.
   - Poll for eligible jobs every 100 ms. Claim the oldest queued row whose `available_at <= now` in a short write transaction.
   - A fresh claim atomically changes status to running, increments attempts, resets progress to zero, clears result/error, and updates `updatedAt`.
   - Await approximately 100 ms per step, then persist its completion. Keep the event loop available for signals and heartbeat updates.
   - At the first step, after that delay but before incrementing progress, simulate failure when `attempts <= failAttempts`.
   - For failed attempts 1 and 2, atomically return the same job to queued with zero progress, null result/error, and `available_at = now + 500 ms`.
   - On failure of attempt 3, atomically set failed with error `"transient failure"`, null result, and attempts 3.
   - On successful intermediate steps, persist progress and timestamp. On the final step, atomically write completed status, full progress, and JavaScript `input.toUpperCase()` output.
   - During retry delays, allow other eligible queued jobs to run; never sleep while holding a database lock.

5. **Handle restarts and shutdown explicitly.**
   - On worker startup, recover any existing running job before claiming fresh work. Replay its interrupted logical attempt from step zero using its persisted attempt number; recovery itself does not consume a transient-failure retry.
   - This preserves the three-attempt budget even if the third attempt was interrupted, while allowing the interrupted job to finish. Ordinary retries still increment attempts on their next queued-to-running transition.
   - Keep retry availability timestamps durable so restarting does not reset a waiting retry.
   - Never select completed or failed jobs for processing.
   - On worker `SIGTERM`/`SIGINT`, stop claiming work, stop heartbeat timers, and exit after the current short step boundary. Leave unfinished work durably running for recovery; clear the heartbeat and close SQLite.
   - On server signals, stop accepting connections, allow active handlers to finish with a bounded shutdown fallback, then close SQLite. Guard against repeated shutdown calls and in-flight handlers accessing a closed database.
   - Rely on SQLite transaction atomicity for `SIGKILL`; no correctness-critical cleanup should depend on a signal handler.

6. **Build the browser page.**
   - Add the form and all required `data-testid` attributes. Initialize numeric fields to steps 5 and failAttempts 0.
   - Use `novalidate` so native form constraints do not prevent API validation errors from reaching the required alert region.
   - Submit input verbatim. Convert nonempty numeric fields with `Number`, without `parseInt` truncation; preserve blank values as invalid rather than accidentally converting blank failAttempts to zero.
   - Clear `form-error` when beginning a new submission and after success. On API rejection, show its message and every offending field’s name using `textContent`.
   - Fetch jobs immediately on load and refresh approximately every 500 ms. Serialize refreshes or discard stale responses so a slow response cannot overwrite newer state.
   - Refresh immediately after successful submission; prevent duplicate form submissions while the request is pending.
   - Render newest-first items carrying `data-job-id`, with exact status text, progress formatted as `completed/total`, and result/error text only in the appropriate terminal state.
   - Use DOM creation and `textContent` for all user-controlled strings. Handle temporary fetch failures without stopping future polling or overwriting submission-validation errors.

7. **Build and verify the complete contract.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Use additional local Node HTTP/process probes and browser inspection for the gaps below. The supplied checks cover only selected examples; do not modify them.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both concurrently against a fresh nested `DATABASE_PATH`; confirm readiness within 10 seconds and a nondefault `PORT`.
- **Validation:** Exercise malformed JSON, arrays/null/primitives, missing/wrong content type, unknown fields, numeric strings, fractions, boundaries, whitespace-only input, and invalid keys. Submit multiple invalid fields together and verify each appears, with no new job.
- **Exact input semantics:** Submit surrounding whitespace, non-ASCII text, and Unicode case mappings; verify stored input is unchanged and output equals JavaScript `toUpperCase()`.
- **Routing:** Check every allowed endpoint, unknown paths, missing IDs, and wrong methods; verify status, error code, and JSON content type.
- **Idempotency:** Check implicit versus explicit defaults, changed values, parallel same-key requests, and replay after server/both-process restarts. Confirm one job per key and separate jobs without keys.
- **Ordering and progress:** Queue several jobs before starting the worker; verify oldest-first processing and newest-first listing. Poll a 20-step job frequently to observe running status and intermediate progress.
- **Retries:** Test failAttempts 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0, 1, and 2; terminal failure at attempt 3 for values 3–5. Observe queued retry delays and zero progress on simulated failures.
- **Heartbeat:** Confirm up during idle work and retries; kill the worker and confirm down after the freshness window, then up after restart.
- **Durability:** Kill both processes with queued, running, waiting-retry, and terminal jobs present. Restart using the same database; verify recovery within the required time, preserved IDs/keys, and unchanged terminal jobs. Repeat with graceful shutdown and interruption during attempt 3.
- **Browser:** Verify every required selector, submission values and field errors, newest-first rendering, and status/progress updates within 2 seconds. Test HTML-like input to confirm it displays as text.
- **Shutdown:** Signal the actual Node processes or their process groups; confirm prompt exit without orphan workers, lingering timers, or database-close errors.

## Risks
- **Recovery versus retry accounting:** Treat replay after a crash as recovery of the persisted logical attempt; blindly incrementing on every restart can exhaust or exceed the three-attempt budget.
- **Database races:** Keep key lookup/insertion and job selection/claim atomic. A unique key alone does not replace transactional replay/conflict handling.
- **SQLite contention:** Preserve WAL and busy timeout, keep transactions short, and perform no asynchronous work inside them.
- **Premature heartbeat staleness:** Maintain heartbeat independently of queue activity and retry waits.
- **Validation coercion:** Apply defaults only to absent fields and never coerce API values. Browser numeric conversion must not s
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
