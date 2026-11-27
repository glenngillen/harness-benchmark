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
Keep the existing TypeScript entry points and dependency-free HTML page, using only Node.js built-ins. Put schema initialization, job serialization, and transactional state changes in shared database code so either process can start first. Persist jobs, idempotency keys, retry deadlines, and worker heartbeats in SQLite; use short transactions and never hold a transaction during a processing delay. The browser will submit through the API and poll for updates every 500 ms.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactions, and database-to-API serialization.
- `src/jobs.ts`: Add shared job/payload types and pure submission validation and normalization.
- `src/server.ts`: Implement routing, JSON request handling, validation, durable idempotency, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat updates, sequential processing, persisted retry scheduling, interrupted-work recovery, and shutdown.
- `ui/index.html`: Implement the submission form, error display, job list, polling, and basic accessible styling.
- Leave all fixed files and `checks/` untouched. Preserve the existing commands and source entry points.

## Steps
1. **Define the SQLite schema and shared representation.**
   - Retain parent-directory creation and the existing `busy_timeout` before enabling WAL. Use `CREATE TABLE/INDEX IF NOT EXISTS` so concurrent server/worker startup is safe. Keep SQLite durability enabled.
   - Create a jobs table with an integer insertion sequence, unique string ID, input, steps, fail-attempt count, status, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, and integer `available_at` retry deadline.
   - Store a nullable unique idempotency key on the job row. Multiple `NULL` keys must be allowed; input, steps, and fail-attempt count are the canonical payload for comparison.
   - Create a singleton worker-heartbeat row containing its last-seen timestamp.
   - Index queued-job selection. Order public lists by insertion sequence descending and processing candidates by insertion sequence ascending; timestamps alone do not reliably order simultaneous submissions.
   - Provide one serializer that returns exactly the specified public fields, nests progress and result correctly, and excludes all internal scheduling/key columns. Use `crypto.randomUUID()` for public IDs and JavaScript `toUpperCase()` for outputs.

2. **Implement validation independently of persistence.**
   - Accept `application/json`, case-insensitively, with optional parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Parse the request body and reject malformed JSON, arrays, `null`, and primitives with `"body"` errors.
   - For object bodies, collect all unknown-property errors and all invalid known-field errors rather than stopping at the first.
   - Require an input string with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Validate with trimming, but preserve the original string.
   - Apply defaults only when `steps` or `failAttempts` is absent. Explicit `null`, strings, booleans, fractions, and out-of-range numbers are invalid. Use `typeof value === 'number'` and `Number.isInteger`.
   - Validate any supplied `Idempotency-Key` against the exact specified regular expression, including rejecting an empty key. Report that exact field name.
   - Include header validation errors alongside body-field errors when the body can be inspected. Never write a job for an invalid request.

3. **Implement the HTTP API and atomic submissions.**
   - Match the URL pathname independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`; distinguish unknown paths (`404`) from unsupported methods on recognized paths (`405`).
   - Serve `/` as HTML using the existing `new URL('../ui/index.html', import.meta.url)` location, which works from `dist/server.js`.
   - Use a shared JSON response/error helper for every API response, including failures. `invalid_request` always includes `fields`.
   - For a valid submission, execute a short `BEGIN IMMEDIATE` transaction:
     - If a key exists, compare the normalized payload to its existing job. Return that job with `200` on equality or `409 idempotency_conflict` otherwise.
     - Otherwise insert one queued job with attempts/progress zero, null result/error, and an immediately eligible deadline. Read its public snapshot before committing and return it with `201`.
   - Preserve that insertion snapshot for the creation response: a worker claiming the row immediately after commit must not turn a `201` response into a running job.
   - Keep the unique-key constraint as a database-level guarantee and roll back on every transaction failure.
   - Implement list/detail reads and missing-job errors. An idempotent replay returns the original job’s current state.
   - Wrap asynchronous request handling so parsing, disconnected clients, and unexpected exceptions cannot become unhandled rejections. Unexpected server errors should use the JSON error envelope.
   - Report health as up only when a persisted heartbeat is at most 3000 ms old; absent/stale heartbeat means down. Server activity must never refresh it.

4. **Implement the worker state machine.**
   - Open and initialize the database, write a heartbeat immediately, and refresh it every 500 ms throughout idle periods, processing, and retries.
   - Use one asynchronous processing loop with a 100 ms idle poll. Select the oldest eligible queued job (`available_at <= now`) and claim it within a short transaction.
   - Claiming a fresh attempt atomically changes status to running, increments attempts, resets progress to zero, clears result/error, and updates `updatedAt`.
   - Await 100 ms for each step. For attempts numbered at most `failAttempts`, fail after the first delay and before incrementing progress.
   - On a transient failure with attempts below three, atomically return the same job to queued with progress zero, null result/error, and `available_at = now + 500 ms`.
   - On the third transient failure, atomically mark failed with error `"transient failure"`, null result, and attempts three.
   - On successful steps, persist progress and `updatedAt` after each delay. On the final step, atomically persist final progress, completed status, and uppercase output.
   - Do not sleep inside transactions. Retry deadlines belong in SQLite so restarting a process cannot erase or bypass the delay. Other eligible jobs may run while an older job waits for its retry deadline.

5. **Handle recovery and lifecycle explicitly.**
   - The task specifies one worker process; perform interrupted-running-job recovery only in the worker, never in server initialization.
   - Before claiming new queued jobs on startup, recover any persisted running job by restarting its unfinished logical attempt from step zero using its persisted attempt number. This continues an interrupted attempt rather than charging a fourth transient-failure attempt after a crash during attempt three.
   - Reset recovered progress/result/error and update the timestamp before processing. Apply the same failure predicate and completion logic; only a subsequent retry after an observed transient failure increments attempts.
   - Recover immediately on startup, within the required ten-second window. Never select completed or failed jobs for work.
   - For worker `SIGTERM`/`SIGINT`, stop taking new work, check the stopping flag after each short sleep, and leave interrupted work durably running for recovery. Stop the heartbeat timer, clear the heartbeat on graceful exit, and close the database.
   - For server shutdown, stop accepting connections, finish active requests, and close SQLite afterward. Use a bounded connection-drain fallback so a stalled client cannot prevent shutdown.
   - Ensure timers and database handles are closed on normal shutdown; abrupt termination must require no cleanup for durable recovery.

6. **Build the browser page.**
   - Include every required `data-testid` exactly as specified, with labels and sensible defaults of steps `5` and fail attempts `0`.
   - Use `novalidate` on the form so browser constraints do not prevent API validation errors from reaching the alert region.
   - On submit, clear `form-error`, send JSON with input unchanged and numeric fields converted using `Number`, and disable the submit button while the request is pending.
   - For rejected submissions, render the API message and every `fields[].field` and associated message into the alert region. Keep it empty otherwise; display useful network failures there as well.
   - Refresh the list on page load, immediately after successful submission, and every 500 ms. Serialize refreshes or discard stale responses so an older response cannot overwrite newer state.
   - Render one `job-item` per job, carrying `data-job-id`, in API order. Include status, exact `completed/total` progress, and output/error text according to terminal status.
   - Insert submitted content and API messages with `textContent`, never interpolated HTML. Keep list polling independent of form error state.

7. **Build and validate the implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Supplement the disclosed checks with temporary local scripts or manual requests and browser inspection; do not modify `checks/` or add dependencies.
   - Use isolated temporary database paths for lifecycle tests and clean up spawned processes after testing.

## Behaviours to verify
- **Startup/configuration:** Start server first, worker first, and both simultaneously with a missing nested database directory. Both become ready within ten seconds using the documented commands.
- **Validation:** Submit malformed JSON, wrong content types, arrays/null, unknown fields, whitespace input, overlong input, invalid numeric values, explicit nulls, and invalid keys. Verify `400`, all relevant field names, and unchanged job count.
- **Exact input semantics:** Submit surrounding whitespace and Unicode input; confirm preserved input, JavaScript string-length validation, and JavaScript uppercase output.
- **Idempotency:** Send concurrent requests with the same key and payload, replay with explicit defaults, and reuse the key with a different payload. Verify one ID, appropriate `201`/`200`/`409` responses, and persistence after server restart.
- **Ordering and routes:** Submit several jobs rapidly while the worker is stopped. Verify newest-first lists, oldest-first processing, detail lookup, JSON `404`, and `405` on recognized paths.
- **Observable processing:** Poll a 20-step job frequently. Verify running status, intermediate progress, approximately 100 ms steps, and atomic terminal result/progress.
- **Retries:** Test `failAttempts` values 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3 respectively, then terminal failure at attempt 3 for the last two; inspect queued retry delays and zero failed-attempt progress.
- **Health:** Verify down without a worker, up during both idle and active work, and down within three seconds after killing the worker.
- **Durability:** Stop and restart both processes against the same database. Kill the worker during processing and during retry waiting, including attempt three. Verify recovery, preserved deadlines, unchanged IDs, and no reprocessing of terminal jobs.
- **Shutdown:** Send `SIGTERM` while idle and active; verify prompt clean exit and successful subsequent restart.
- **Browser:** Check all selectors, numeric submission types, rejection field names, newest-first rendering, empty nonterminal results, and updates within two seconds without reload.

## Risks
- **SQLite contention:** Retain busy timeout/WAL setup, initialize schema idempotently, and keep all write transactions short.
- **Idempotency races:** An in-m
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
