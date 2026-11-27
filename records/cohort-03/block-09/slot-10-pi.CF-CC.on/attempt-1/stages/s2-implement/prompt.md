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
Keep the existing TypeScript entry points and npm commands, using only Node.js built-ins. Share database initialization, job serialization, and transactional state changes between the HTTP server and the separate worker; SQLite is their only communication channel. Persist jobs, idempotency keys, retry deadlines, and worker heartbeats so restarts do not lose state. Serve a self-contained browser page that submits through the API and polls for updates.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactions, and durable worker heartbeat storage.
- `src/jobs.ts`: Add job types, normalized submission types, validation, and a single public job serializer.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, observable progress, retries, restart recovery, heartbeats, and graceful shutdown.
- `ui/index.html`: Add the submission form, job list, error display, polling script, and lightweight styling.
- Leave all fixed files and `checks/` untouched.

## Steps
1. **Define the shared schema and public representation.**
   - Retain parent-directory creation and the existing ordering of `busy_timeout` before WAL configuration. Use short transactions and explicit durable SQLite settings, such as `synchronous=FULL`.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from either process, allowing either startup order.
   - Store jobs with an internal monotonically increasing sequence, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed steps, output, error, creation/update timestamps, and a numeric retry deadline.
   - Store an optional idempotency key under a unique constraint, either directly on the job or in a linked table. Multiple jobs without keys must remain possible.
   - Store a singleton worker heartbeat timestamp. Only the worker writes it.
   - Use the internal sequence for deterministic newest-first listing and oldest-first processing, including jobs created within the same millisecond.
   - Centralize serialization to emit exactly the specified job shape. Hide internal columns; derive `progress.total` from `steps`, and expose `result` and `error` only for their respective terminal statuses.

2. **Implement complete validation before any database mutation.**
   - Read the request stream and parse JSON, handling malformed JSON and stream failures without an unhandled rejection.
   - Accept the `application/json` media type case-insensitively, including parameters such as `charset=utf-8`; missing or other media types produce a `"body"` field error.
   - Require a non-null, non-array JSON object. Use `"body"` for malformed JSON or a non-object body.
   - Enumerate unknown own properties and report every offending field.
   - Validate `input` using JavaScript string length and `trim()` only for the whitespace test; store the original string unchanged.
   - Apply defaults only when `steps` or `failAttempts` is absent. Reject null, strings, booleans, fractional numbers, and out-of-range values.
   - Validate the optional `Idempotency-Key` against the exact required expression. Reject ambiguous duplicate header values rather than silently choosing one.
   - Accumulate all applicable errors, including header errors, into `invalid_request.fields`; do not stop after the first invalid object property.

3. **Make creation and idempotency atomic.**
   - Normalize to `{input, steps, failAttempts}` after successful validation.
   - Use `BEGIN IMMEDIATE` around key lookup, comparison, and insertion; commit or roll back on every path.
   - For an existing key, compare the three normalized values directly. Return its current job representation with `200`, or `409 idempotency_conflict` for a mismatch.
   - For a new submission, assign `randomUUID()`, initialize queued state, zero attempts/progress, null result/error, and ISO timestamps.
   - Capture the newly inserted queued representation inside the transaction and return it with `201`. Do not re-read it after committing, since the worker could already have claimed it.
   - Back the transactional logic with a unique database constraint so persistence and concurrent submissions cannot create duplicates.

4. **Implement the HTTP routes and lifecycle.**
   - Match paths independently of methods. Support `GET /`, `GET /health`, `GET` and `POST /api/jobs`, and `GET /api/jobs/:id`.
   - Return `405 method_not_allowed` for unsupported methods on recognized paths, optionally with `Allow`; return `404 not_found` for unknown paths and missing job IDs.
   - Use one JSON response/error helper for all API responses, including unexpected failures. Every `invalid_request` includes `fields`.
   - Compute worker health from the persisted heartbeat: up only when it exists and is no more than three seconds old. The server must never infer health from job status or update the heartbeat itself.
   - Preserve the existing `new URL('../ui/index.html', import.meta.url)` asset lookup, which works from the compiled `dist/server.js`.
   - On `SIGTERM`/`SIGINT`, stop accepting requests, finish active handlers, then close SQLite. Bound shutdown for stalled connections and avoid closing the database while handlers still use it.

5. **Implement the worker’s durable state machine.**
   - Write a heartbeat immediately after initialization and every 500 ms while idle, processing, or waiting for a retry. Use asynchronous timers so step delays do not block heartbeats.
   - Recover an interrupted `running` job before selecting ordinary queued work. Under the specified single-worker deployment, startup can recover it immediately.
   - Treat recovery as continuation of its already-recorded attempt: preserve `attempts`, reset progress, and replay that attempt’s processing from the beginning. This avoids charging an interrupted attempt twice or turning a crash on attempt three into an unintended fourth retry.
   - Poll eligible queued jobs about every 100 ms. Select the oldest whose persisted retry deadline has passed.
   - Claim a queued job transactionally: change it to `running`, increment attempts, reset progress, clear result/error, and update its timestamp. Never hold a transaction open across a sleep.
   - Wait approximately 100 ms per step. At the first step, if the current attempt number is at most `failAttempts`, fail before recording any progress.
   - For a simulated failure on attempts one or two, atomically return the job to `queued`, retain zero progress and null public error/result, and persist a retry deadline 500 ms in the future.
   - For the third simulated failure, atomically mark it `failed` with exactly `"transient failure"` and null result.
   - For successful steps, persist completed progress and `updatedAt` after each delay. On the last step, atomically set completed progress, status `completed`, and output from JavaScript `input.toUpperCase()`.
   - Never select completed or failed jobs. Database or programming errors must not be mislabeled as simulated transient failures.
   - On termination, stop claiming jobs and stop at a step boundary. Leave any interrupted job durably `running` for recovery, clear the heartbeat, cancel timers, and close SQLite.

6. **Build the browser page around the API contract.**
   - Add every required `data-testid`, with each job item carrying `data-job-id`. Keep `form-error` present with `role="alert"` even when empty.
   - Default numeric controls to 5 and 0. Convert numeric values with `Number`, not `parseInt`, so fractional values are not silently truncated. Send an invalid empty numeric value as null rather than silently applying a default.
   - Use `novalidate` on the form so browser validation does not prevent the API from returning the required field errors.
   - On submit, clear the prior rejection, send JSON, and display the API error message plus every field name and field message on rejection. Clear the region after a successful submission.
   - Refresh the list immediately after successful submission and poll approximately every 500 ms. Serialize refreshes or discard stale responses to prevent older responses from replacing newer state.
   - Render server-provided newest-first order, exact status text, progress as `completed/total`, and terminal result/error text.
   - Use DOM creation and `textContent` for submitted text and results. Polling must not reset form fields or erase a submission rejection. Report connectivity failures separately from API field validation.

7. **Build and validate the completed implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`. These checks already launch both processes with isolated databases.
   - Supplement the disclosed checks with the cases below using temporary databases, HTTP requests, process control, and a browser. Do not modify the fixed checks or add dependencies.

## Behaviours to verify
- **Startup and configuration:** Start each process first, then start both concurrently against a new nested database path; confirm readiness within 10 seconds and correct custom `PORT`/`DATABASE_PATH`.
- **Validation:** Submit malformed JSON, arrays, null, missing content type, unknown fields, numeric strings, fractions, invalid bounds, whitespace input, and invalid keys. Check multiple simultaneous field errors and unchanged job count.
- **Defaults and exact input:** Compare omitted defaults with explicit defaults; confirm leading/trailing whitespace is preserved and Unicode output uses JavaScript uppercase semantics.
- **Idempotency:** Send concurrent requests sharing a key, replay after server restart, and reuse the key with changed payloads. Verify one job, matching replay IDs, and correct `200`/`409` responses. Requests without keys must create separate jobs.
- **Routing:** Exercise unsupported methods on every known route, unknown paths, and missing IDs; check status, code, and JSON content type.
- **Processing:** Poll a 20-step job frequently; observe running status and increasing progress, approximately 100 ms steps, and final output. With multiple queued jobs, confirm sequential oldest-first processing.
- **Retries:** Test `failAttempts` from 0 through 5. Confirm attempts of 1, 2, or 3 as appropriate, zero progress on simulated failures, observable queued retry delays, and the exact terminal failure message.
- **Health:** Check down without a worker, up while idle and busy, and down within three seconds after killing the worker.
- **Durability:** Stop and restart both processes using the same database. Kill the worker during processing and during a retry delay, including on attempt three; confirm recovery within the required window, retained retry deadlines, no duplicate jobs, and untouched terminal jobs.
- **Shutdown:** Send `SIGTERM` while idle and busy; confirm prompt clean exit, no lingering timer, and valid persisted state.
- **Browser:** Verify all selectors, numeric JSON values, multi-field rejection text, newest-first ordering, live progress/results within two seconds, and safe literal rendering of HTML-like input.

## Risks
- **SQLite contention:** Startup schema work and job claims can race. Retain busy timeout, initialize idempotently, use short transactions, and never sleep while holding a write lock.
- **Restart semantics:** Recovery must distinguish continuing an interrupted attempt from retrying a known failure. Preserve the durable attempt number for recovery and increment only when claiming a queued attempt.
- **Accidental state loss:** Never recreate tables or clear jobs on startup. Persist retry deadlines instead of relying on in-memory timers.
- **Validation shortcuts:** Truthiness defaults, numeric coercion in the API, trimming stored input, or early-return validation can violate the contract.
- **UI races:** Overlapping polls can regress displa
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
