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
Extend the existing TypeScript entry points using only Node.js built-ins. SQLite will hold jobs, idempotency keys, retry deadlines, and worker heartbeats; the server and worker will communicate exclusively through it. Use short transactions for state transitions and asynchronous timers for processing, keeping progress and health observable. Serve the browser application from the existing `ui/index.html`, polling the API every 500 ms.

## Files
- `src/db.ts`: Extend database initialization with schema creation, typed job mapping, prepared queries, and transactional persistence operations.
- `src/jobs.ts`: Add job/payload types and request validation with aggregated field errors.
- `src/server.ts`: Implement API routing, request parsing, idempotent submission, health reporting, HTML serving, and shutdown.
- `src/worker.ts`: Implement heartbeat, queue selection, processing, retries, restart recovery, and shutdown.
- `ui/index.html`: Implement the required form, accessible error region, job list, and polling.
- Leave configuration, dependencies, command scripts, and `checks/` unchanged.

## Steps
1. **Define the shared database schema and initialization.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL initialization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from either process, so either startup order works.
   - Store jobs with an internal monotonic integer sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, and an epoch-millisecond retry deadline.
   - Store the optional idempotency key in a nullable unique column on the job. Compare immutable input, steps, and fail-attempt columns directly for replay matching.
   - Add a singleton worker-heartbeat table. Use integer epoch milliseconds for heartbeat age.
   - Use the sequence for deterministic oldest/newest ordering, including submissions with identical timestamps.
   - Centralize serialization into the exact public job shape. Hide internal fields; derive `progress.total` from `steps`, and return explicit `null` for absent result/error.
   - Use parameterized statements. Wrap multi-statement mutations in `BEGIN IMMEDIATE` with commit/rollback, never holding a transaction across an `await`.

2. **Implement validation before database mutation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or different media types with field `"body"`.
   - Read the complete body and parse JSON. Empty/malformed JSON, arrays, `null`, and primitive values produce `"body"` errors.
   - For object bodies, collect every unknown field and every invalid recognized field instead of stopping at the first error.
   - Require a string input with JavaScript `.length` from 1–1000 and a nonempty `.trim()`, while storing the original string unchanged.
   - Apply numeric defaults only when the property is absent. Reject `null`, booleans, numeric strings, fractions, and out-of-range values.
   - Validate a present `Idempotency-Key` against the exact required pattern; reject empty or duplicate/multivalued headers rather than silently choosing one.
   - Aggregate header and body/field errors where possible. Every `invalid_request` includes `fields` with field names and useful messages.

3. **Implement the HTTP API and atomic idempotency.**
   - Retain the existing module-relative HTML path; it resolves correctly from `dist/server.js`.
   - Route by pathname, independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and single-segment `/api/jobs/:id`.
   - Determine whether the route exists before dispatching its method: unsupported methods on recognized routes return `405 method_not_allowed`; unmatched paths return `404 not_found`.
   - Send every API response and route error through one JSON response helper. Only successful `GET /` serves HTML.
   - For submission, validate and normalize first. In one short write transaction, look up a supplied key and either return its existing job, report a payload conflict, or insert a new UUID-backed queued job.
   - Return the inserted queued snapshot with `201`, rather than rereading after commit when the worker might already have claimed it. Replays return the existing job’s current state with `200`.
   - Initialize attempts/progress to zero, result/error to null, and both timestamps to the same ISO value.
   - Implement list ordering by descending sequence and individual lookup with a structured `404`.
   - `/health` returns worker `"up"` only when a persisted heartbeat is at most 3 seconds old.
   - Catch asynchronous request failures so rejected handlers do not crash the process. Return structured internal errors for unexpected failures without exposing SQL details.

4. **Implement worker scheduling and heartbeat.**
   - Write a heartbeat immediately after initialization and every 500 ms thereafter, including while idle, processing, or awaiting retry deadlines.
   - Poll for work every 100 ms. Select the oldest queued job whose persisted retry deadline has passed.
   - Atomically claim it, setting `running`, incrementing attempts, resetting progress to zero, clearing result/error, and updating its timestamp.
   - Process one job at a time with awaited 100 ms step delays. Persist each completed step in a separate short update.
   - On a simulated failure, wait for the first step’s timer, then fail before incrementing progress when the current attempt number is at most `failAttempts`.
   - For failed attempts below three, atomically return the same job to `queued`, leave error/result null, and set a retry deadline 500 ms ahead. Do not immediately reclaim it.
   - On the third simulated failure, set `failed`, error `"transient failure"`, result null, and progress zero.
   - On successful steps, increment progress. Commit the last increment, `completed` status, and JavaScript `input.toUpperCase()` output together.
   - Keep heartbeat writes separate from processing semantics; health must remain current during a 20-step job.

5. **Implement restart recovery and clean termination.**
   - Under the task’s single-worker topology, inspect stale `running` jobs when the worker starts and make them recoverable immediately. The server must never reset running jobs.
   - Preserve job IDs, creation timestamps, idempotency mappings, and attempts already recorded. Reset partial progress when reprocessing an interrupted job.
   - Persist retry deadlines so restarting does not erase an outstanding retry wait.
   - Explicitly handle interruption during attempt three: do not strand the job or create a fourth ordinary retry. Recover the interrupted third attempt by replaying its work from zero with its existing attempt number; its simulated-failure rule remains unchanged. For earlier interrupted attempts, requeue and start the next recorded attempt.
   - Never recover or claim terminal jobs.
   - On worker `SIGTERM`/`SIGINT`, stop taking new jobs, finish the current bounded attempt, clear heartbeat/timers, close SQLite, and exit. A resulting queued retry remains durable for the next worker.
   - On server shutdown, stop accepting requests, allow active handlers to finish, close idle connections, and close SQLite afterward. Bound shutdown of lingering connections.
   - Use `finally` cleanup for both processes. Abrupt termination requires no cleanup for committed SQLite state to survive.

6. **Build the browser page.**
   - Add the required `job-form`, input/steps/fail-attempt fields, submit button, empty `form-error` with `role="alert"`, and `job-list`.
   - Default numeric controls to 5 and 0. Use `novalidate` so browser constraints do not prevent API rejection messages from being shown.
   - Submit exact input text and numeric values converted to numbers. Treat empty/invalid numeric entries as invalid values rather than silently substituting defaults or converting empty text to zero.
   - Clear submission errors on a new submission and after success. On API rejection, show the message and every offending field name.
   - Fetch jobs on page load, immediately after successful submission, and every 500 ms. Serialize refreshes or discard stale responses so an older response cannot overwrite newer state.
   - Render newest first. Each job gets `data-testid="job-item"` and `data-job-id`; nested status, progress, and result elements use the specified attributes and text.
   - Render user content through `textContent`, never interpolated HTML. Show output only for completed jobs, error only for failed jobs, and empty result text otherwise.
   - Keep polling failures separate from the submission-error region and recover on subsequent polls.

7. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with HTTP, process-restart, and browser checks below; the existing suites explicitly omit substantial contract coverage.
   - Keep any additional verification helpers under `src/` if committed; do not modify fixed files or add dependencies.

## Behaviours to verify
- **Startup/configuration:** Start each process first in separate runs, using a fresh nested `DATABASE_PATH` and custom port. Verify readiness within 10 seconds and automatic directory/schema creation.
- **Validation:** Exercise malformed/empty JSON, wrong media types, nonobjects, whitespace input, Unicode length boundaries, unknown fields, numeric strings, fractions, nulls, and multiple simultaneous errors. Confirm field names and unchanged job count.
- **Routing:** Check unknown paths, missing IDs, and unsupported methods on every known route; verify JSON error codes and content types.
- **Idempotency:** Send concurrent identical-key submissions, then conflicting payloads. Compare omitted versus explicit defaults. Restart the server and replay again; exactly one job must exist.
- **Ordering:** Submit several jobs with the worker stopped, including rapid submissions. Verify newest-first listing and oldest-first processing after worker startup.
- **Progress and output:** Poll a 20-step job every 50 ms. Observe running progress, approximately 100 ms step spacing, stable attempt count, and final output matching JavaScript uppercase behavior, including Unicode.
- **Retry rules:** Test `failAttempts` from 0 through 5. Verify final attempts are 1, 2, or 3 as appropriate, failed attempts make no progress, retry waits are at least 250 ms, and failures use the exact required error.
- **Health:** Observe `"down"` without a worker, `"up"` while idle/busy/retrying, and `"down"` within the heartbeat expiry after killing it.
- **Durability:** Kill the worker during processing and retry waits; restart on the same database. Also stop both processes and restart in reversed order. Verify recovery, retained IDs/state, and no reprocessing of completed/failed jobs.
- **Shutdown:** Send `SIGTERM` to the actual processes or process groups; confirm timely clean exits without pending timers or locked database failures on restart.
- **Browser:** Check every required selector, numeric submission payloads, multi-field rejection text, initial persistent jobs, automatic updates within 2 seconds, failed/completed result text, and harmless rendering of HTML-like input.

## Risks
- **Concurrent SQLite initialization or writes:** Preserve the existing busy-timeout setup and keep transactions short; never sleep while holding a write lock.
- **Idempotency races:** A lookup followed by an unprotected insert is insufficient. Use a transaction plus a unique database constraint.
- **Crash recovery versus retry limits:** Interrupted work needs an explicit exhausted-attempt path; otherwise restart can leave jobs stuck or create unlimited retries.
- **Premature/stale API state:** Return the insertion snapshot for `201`, while replay and look
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
