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
Implement the API and worker with Node.js built-ins, using SQLite as their only shared state. Extend the existing database opener with idempotent schema initialization and short transactions for submissions and job transitions. Keep the worker asynchronous between database writes so progress and heartbeat remain observable. Serve a self-contained browser page from the existing `ui/index.html` and poll the API for updates.

## Files
- `src/db.ts`: Preserve `openDatabase`; add schema initialization, transaction helpers, typed job storage operations, and heartbeat persistence.
- `src/jobs.ts` (new): Define public job types, normalize and validate submissions, and map database rows to the exact API representation.
- `src/server.ts`: Replace placeholder routing with the complete API, HTML serving, request parsing, error handling, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, queue selection, step processing, delayed retries, interrupted-job recovery, and graceful shutdown.
- `ui/index.html`: Add the submission form, error region, job list, styling, and browser JavaScript.
- Leave all fixed files and `checks/` unchanged. Preserve existing entry points and build commands.

## Steps
1. **Initialize durable storage from either process.**
   - Keep directory creation and the existing `busy_timeout = 5000` before WAL configuration.
   - Create tables and indexes with `IF NOT EXISTS`, inside a short initialization transaction. Use `synchronous = FULL` for committed-state durability.
   - Store jobs with an internal integer insertion sequence, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, and numeric `available_at`.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first processing, including submissions sharing a timestamp.
   - Store worker heartbeat in a separate singleton row with its timestamp in epoch milliseconds.
   - Centralize row serialization: return only the specified public properties, derive `progress.total` from `steps`, and expose output/error only in their corresponding terminal status.
   - Use prepared statements and bound parameters. Transaction helpers must roll back on exceptions; never hold a transaction across an `await`.

2. **Implement validation and canonical payloads.**
   - Parse the request media type case-insensitively, accepting `application/json` with parameters such as `charset=utf-8`.
   - Read the complete body before parsing JSON. Empty or malformed JSON, null, arrays, and primitives produce an invalid-request entry for `body`.
   - For an object, collect all detectable field errors rather than returning after the first.
   - Reject every unknown own property, including unusual names such as `__proto__`.
   - Require `input` to be a string with JavaScript `.length` from 1 through 1000 and a nonempty `.trim()`. Preserve the original string.
   - Apply numeric defaults only when the property is absent. Require actual numbers satisfying `Number.isInteger` and the documented ranges; reject null, booleans, and numeric strings.
   - Validate a present `Idempotency-Key` against the exact regex. Empty and duplicate header values must not silently become an absent or valid key. Report errors under `Idempotency-Key`.
   - Normalize valid submissions to `{ input, steps, failAttempts }`. Compare these three values directly for idempotency.

3. **Implement atomic submissions and API routes.**
   - Match paths independently of methods, ignoring query strings. Known paths are `/`, `/health`, `/api/jobs`, and `/api/jobs/<single-id-segment>`.
   - Return `405 method_not_allowed` for unsupported methods on known paths; return `404 not_found` for unknown paths and missing jobs.
   - Use a shared JSON response/error helper. Every API response, including errors, has `application/json`; invalid-request errors always contain `fields`.
   - Validate submissions before any database mutation.
   - In a `BEGIN IMMEDIATE` transaction, look up the idempotency key if present. Return the existing job with 200 when normalized values match, or 409 without mutation when they differ.
   - Otherwise insert a UUID job with status `queued`, attempts and progress zero, null output/error, and matching creation/update timestamps. Commit before responding.
   - Construct the 201 response from the inserted queued snapshot inside the transaction, so a fast worker cannot change the creation response to `running`.
   - Back key uniqueness with a database constraint, not just an application lookup.
   - Implement list and detail reads through the shared serializer.
   - `/health` returns worker `up` only when the persisted heartbeat is at most 3000 ms old; a missing or stale heartbeat means `down`.
   - Continue loading HTML through `new URL('../ui/index.html', import.meta.url)`, which works from the existing `dist/server.js` layout.
   - Catch asynchronous handler failures and return a structured 500 response when possible, without exposing database details.

4. **Implement the worker state machine.**
   - Open and initialize the database, write an immediate heartbeat, and refresh it every 500 ms throughout idle waits, processing, and retry waits.
   - Poll for work every 100 ms. Select the oldest eligible queued job with `available_at <= Date.now()`.
   - Atomically claim a job in a short transaction: set `running`, increment attempts, reset progress to zero, clear result/error, and update `updatedAt`.
   - Process only one job at a time. Await approximately 100 ms per step rather than blocking the event loop.
   - After the first step delay, if the attempt number is at most `failAttempts`, fail before incrementing progress.
   - For a transient failure on attempts 1 or 2, atomically return the same job to `queued`, keep progress zero and result/error null, and persist `available_at = now + 500 ms`.
   - Retry delays must survive restarts. Other eligible jobs may run while a retry waits.
   - On the third transient failure, atomically set `failed`, error `"transient failure"`, null result, and attempts 3.
   - For successful steps, persist the increasing completed count and timestamp after each delay. On the final step, atomically write full progress, status `completed`, and `input.toUpperCase()`.
   - Never select terminal jobs for processing.

5. **Recover interrupted work and shut down cleanly.**
   - Only the worker performs recovery; starting or restarting the server must not alter running jobs.
   - At worker startup, recover an existing `running` job before selecting queued work. Replay its interrupted logical attempt from step zero, retaining its persisted attempt number. This avoids manufacturing a fourth retry when interrupted during attempt 3; the same attempt’s transient-failure rule still applies.
   - Persist the progress reset and updated timestamp before replaying. Completed and failed rows remain untouched.
   - The task specifies a single worker process; document that recovery assumes the previous worker has exited.
   - On worker SIGTERM/SIGINT, stop claiming work, interrupt sleeps or check the stop flag after each short sleep, clear heartbeat scheduling, remove the heartbeat, and close SQLite. Leave any interrupted job `running` for startup recovery.
   - On server SIGTERM/SIGINT, stop accepting requests, drain active handlers, close idle connections, and close SQLite afterward. Bound shutdown for stalled connections so it does not hang.
   - SIGKILL requires no special cleanup: committed progress survives, heartbeat expires, and startup recovers interrupted work.

6. **Build the browser page.**
   - Add all required test IDs exactly: form, three inputs, submit button, alert region, job list, and each job’s item/status/progress/result.
   - Set `data-job-id` on each job item. Render newest first using API order.
   - Use a textarea for input and numeric fields initially containing 5 and 0. Submit numeric values as JSON numbers; represent empty numeric fields as an invalid value such as null rather than inadvertently coercing them to zero.
   - Use `novalidate` on the form so browser constraints do not hide API validation responses.
   - Clear the alert when a new submission begins. On API rejection, display its message and every offending field name/message using `textContent`.
   - Disable submission while its request is pending, then restore it in `finally`.
   - Fetch jobs immediately on load and after submission, then poll every 500 ms. Coordinate refreshes so requests do not overlap or allow an older response to overwrite newer state.
   - Render status verbatim, progress as `completed/total`, and result as output, terminal error, or empty text.
   - Use DOM creation and `textContent` for all submitted and returned values to avoid HTML injection. Keep list-refresh errors separate from the form’s validation alert.

7. **Validate the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with local HTTP probes, process restart scenarios, and browser inspection below. The existing checks explicitly omit many required behaviors.
   - Use fresh temporary database paths for independent scenarios, retaining the same path within durability tests. Do not modify fixed checks or configuration.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate trials, including simultaneous startup, using a missing parent directory and custom port/path. Both start within 10 seconds.
- **Exact representation:** Inspect creation, running, retry, completed, and failed responses; ensure internal database fields never leak and null/result/error rules hold.
- **Validation:** Submit missing fields, multiple invalid fields, unknown properties, numeric strings, nulls, fractions, range boundaries, whitespace input, malformed JSON, arrays, and missing/wrong content types. Confirm every detectable offending field is named and no job is inserted.
- **String semantics:** Test preserved surrounding whitespace, Unicode expansion such as `ß`, and inputs near the 1000 UTF-16-code-unit boundary.
- **Routing:** Exercise wrong methods on every known route, unknown paths, and missing IDs. Confirm JSON error codes and status codes.
- **Idempotency:** Replay omitted versus explicit defaults, change each payload field separately, submit concurrent requests with the same key, and replay after restarting the server. Exactly one job must exist.
- **Processing and ordering:** Queue several jobs before starting the worker. Observe oldest-first claims, one active job, visible progress, and pickup within one second when idle.
- **Retries:** Check `failAttempts` 0, 1, 2, 3, and 5. Expected attempt counts are 1, 2, 3, 3, and 3, with the last two jobs failed. Observe queued retry intervals and zero progress on simulated failures.
- **Health:** Confirm `down` without a worker, `up` during long jobs and retry waits, and `down` within three seconds after killing it.
- **Durability:** Kill the worker during visible progress, restart it, and verify recovery within the required bound. Repeat during attempt 3 and a queued retry. Restart both processes and verify terminal jobs, keys, and ordering survive without reprocessing.
- **Clean shutdown:** Send SIGTERM to actual server/worker processes and verify prompt exit without uncaught errors or lost committed state.
- **Browser:** Submit successful and rejected jobs, inspect all required attributes, confirm error field names, and observe status/progress/result updates within two seconds without reloading.

## Risks
- **SQLite contention:** Preserve busy-timeout-before-WAL ordering, keep write transactions short, and never sleep while holding a transaction.
- **Idempotency races:** Enforce uniqueness in SQLite and perform lookup/comparison/insertion atom
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
