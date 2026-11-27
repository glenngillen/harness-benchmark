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
Use the existing Node.js HTTP server and separate worker, with SQLite as their only shared state and communication channel. Centralize schema initialization, job serialization, and short transactional operations so either process can start first. Persist retry deadlines and worker heartbeats, and recover interrupted processing without touching terminal jobs. Build the browser page with plain HTML and JavaScript, polling the API every 500 ms.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, transactions, prepared queries, and job serialization.
- `src/jobs.ts`: Add job/payload types, validation, and normalized payload comparison.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat updates, sequential processing, durable retries, recovery, and shutdown.
- `ui/index.html`: Implement the submission form, validation feedback, and automatically refreshed job list.
- Leave all fixed files, commands, and `checks/` unchanged.

## Steps
1. **Define the durable schema and public representation.**
   - Preserve directory creation and the existing `busy_timeout` initialization before enabling WAL.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both entry points.
   - Store jobs with an internal insertion sequence, unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO timestamps, and an internal retry-eligible timestamp.
   - Store a nullable unique idempotency key on the job. The immutable input, steps, and fail-attempt fields provide the normalized payload for comparison; multiple `NULL` keys must be allowed.
   - Add a singleton worker-heartbeat table containing a timestamp.
   - Use the insertion sequence for deterministic oldest/newest ordering, including submissions sharing the same millisecond.
   - Implement one serializer used by every job-returning endpoint. Exclude internal fields; expose `progress: { completed, total: steps }`, `result: { output }` only for completed jobs, and `error` only for failed jobs.
   - Use bound SQL parameters throughout. Transactions must be synchronous and short, with rollback on failure; never hold one across a sleep or HTTP body read.

2. **Implement validation before any submission mutation.**
   - Read the complete UTF-8 body and parse JSON with explicit handling for malformed or empty bodies.
   - Require media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Missing or incompatible content type produces a `"body"` error.
   - Require a non-null, non-array JSON object. Reject every unknown own property and collect all independently detectable field errors.
   - Validate `input` as a string with JavaScript length 1–1000 and at least one non-whitespace character. Preserve its original contents.
   - Apply defaults only when properties are absent: `steps = 5`, `failAttempts = 0`. Explicit `null`, numeric strings, booleans, fractions, and out-of-range values fail validation.
   - Validate a present `Idempotency-Key` against the exact specified pattern; an empty header is invalid. Reject duplicate key headers rather than silently choosing one.
   - Return `400` with `error.code = "invalid_request"`, a message, and `fields` entries naming every offending field. Body-level failures use `"body"`; header failures use `"Idempotency-Key"`.
   - Ensure validation errors create neither jobs nor reserved keys.

3. **Implement HTTP routing and atomic submissions.**
   - Match the pathname separately from the method. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`; reject extra path segments.
   - Return JSON `404 not_found` for unknown routes and missing jobs. Return JSON `405 method_not_allowed` for unsupported methods on recognized routes, optionally with an `Allow` header.
   - Keep `/` as HTML using the existing module-relative `../ui/index.html` lookup, which works from `dist/server.js`.
   - Implement list/get endpoints using the shared serializer, with the list ordered by insertion sequence descending.
   - For submission, use `BEGIN IMMEDIATE`: look up the key if present, compare the three normalized payload values, then either return the original job, return a conflict, or insert a new queued job.
   - Keep the unique key constraint as database-level protection against concurrent submissions and restarts.
   - A new job has attempts/progress zero and null result/error. Capture its inserted queued representation inside the transaction and return it with `201`; do not reread after commit, since the worker might already have claimed it.
   - Return an existing job’s current representation with `200` for an identical replay, or `409 idempotency_conflict` for a different valid payload.
   - Implement `/health` using the persisted heartbeat: worker is up only when its last heartbeat is no more than 3 seconds old. The server must never update this heartbeat.
   - Route asynchronous handler errors through a common JSON error responder, avoiding unhandled promise rejections or duplicate responses.

4. **Implement the worker’s processing state machine.**
   - On startup, initialize the database and write a heartbeat immediately. Refresh it every 500 ms, including while processing or waiting for retries.
   - Poll for work every 100 ms when idle. Select the oldest eligible queued job; a job whose retry deadline is in the future must not prevent other eligible jobs from running.
   - Claim the selected job atomically: set `running`, increment attempts, reset completed steps to zero, clear result/error, and update `updatedAt`.
   - Process exactly one job at a time. Wait approximately 100 ms before each step.
   - On the first step, if the current attempt number is at most `failAttempts`, fail before recording any progress.
   - If this is attempt 1 or 2, persist `queued` with a retry deadline 500 ms in the future, zero progress, and null result/error.
   - If this is attempt 3, persist `failed`, error `"transient failure"`, null result, zero progress, and attempts 3.
   - Otherwise persist each completed step independently so readers can observe progress.
   - On the final step, atomically persist full progress, `completed`, output from JavaScript `input.toUpperCase()`, null error, and an updated timestamp.
   - Never select completed or failed jobs.

5. **Make restart and shutdown behavior explicit.**
   - Support the specified single-worker deployment. At worker startup, recover persisted `running` jobs before taking new queued work.
   - Treat recovery as restarting the interrupted logical attempt from step zero, retaining its already-recorded attempt number. This avoids double-counting an attempt that had started before the crash and allows an interrupted third attempt to finish without inventing a fourth retry.
   - Reapply the same first-step failure rule during recovery. A third attempt that should transiently fail must become failed; an interrupted successful third attempt must finish.
   - Preserve queued retry deadlines across restarts. Recovery starts immediately, well inside the restart allowance.
   - On worker `SIGTERM`/`SIGINT`, stop taking work and interrupt short waits. Leave unfinished processing durably marked running for recovery, stop heartbeat updates, clear the heartbeat, and close SQLite.
   - On server shutdown, stop accepting connections, finish active requests with a bounded shutdown period, close remaining connections if necessary, then close SQLite.
   - Do not erase jobs or reinitialize heartbeat state when the server starts. A killed worker’s heartbeat naturally expires after 3 seconds.

6. **Build the browser UI around the actual API contract.**
   - Add every required `data-testid`, including a persistent, initially empty `form-error` region with `role="alert"`.
   - Use defaults 5 and 0 for the numeric fields. Send their values as numbers; do not use `parseInt`, which would silently truncate invalid fractional input.
   - Use `novalidate` so browser constraint validation does not suppress API validation feedback. Convert empty/invalid numeric entries to a value the API rejects, such as `null`, rather than accidentally interpreting an empty fail-attempt field as zero.
   - Submit JSON to `/api/jobs`. Clear prior errors when starting a submission and after success; for API rejection, display the error message and every returned field name/message.
   - Fetch the list on load, after successful submission, and every 500 ms. Prevent overlapping list fetches or discard stale responses so older snapshots cannot overwrite newer state.
   - Render one `job-item` with `data-job-id` per job, newest first. Include status, exact `completed/total` text, and result/error text according to status.
   - Insert user input, outputs, and error text using `textContent`, never interpolated HTML.
   - Keep the form intact during list updates and recover polling after temporary fetch failures.

7. **Build and verify without changing the fixed checks.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with local HTTP scripts and browser inspection for the cases below. Use isolated temporary database paths and cleanly stop spawned processes.
   - Keep any added verification source under `src/` if committed; do not modify package scripts or `checks/`.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate runs, including simultaneous startup with a nonexistent database parent directory. Confirm readiness within 10 seconds and that custom `PORT`/`DATABASE_PATH` work.
- **Validation:** Submit malformed JSON, arrays, null, missing content type, unknown fields, whitespace-only input, length boundaries, Unicode input, numeric strings, fractions, null numeric values, and invalid keys. Check all offending fields and unchanged job count.
- **Idempotency:** Replay omitted versus explicit defaults, change each payload field, send concurrent requests with one key, and replay after server restart. Confirm one job and correct `201`/`200`/`409` responses. No-key duplicates must create separate jobs.
- **Routing and representation:** Exercise every endpoint, unknown routes, and wrong methods. Check JSON error shapes, nullability, timestamps, deterministic list order, and exact input preservation.
- **Progress and pickup:** Poll a 20-step job frequently; confirm pickup within 1 second, visible intermediate progress, roughly 100 ms steps, and final JavaScript uppercase output.
- **Retries:** Exercise `failAttempts` 0 through 5. Verify attempts 1/2/3 as appropriate, queued retry intervals of at least 250 ms, no progress on simulated failure, exact terminal error, and no duplicate jobs.
- **Durability:** Kill the actual worker process during running work and during retry waits; restart with the same database. Repeat with both processes stopped, and with SIGTERM. Confirm recovery, persisted keys/deadlines, unchanged terminal jobs, and interrupted third-attempt behavior.
- **Health:** Check down before worker startup, up while idle/processing/retrying, and down within roughly 3 seconds after SIGKILL.
- **UI:** Submit valid and invalid forms; verify required test IDs, field names in alerts, updates within 2 seconds, exact progress formatting, final output/error, newest-first order, and safe display of HTML-like input.

## Risks
- **Concurrent SQLite startup or writes:** Preserve busy-timeout-before-WAL ordering and keep write transactions short. Do not sleep inside transactions.
- **Creation response races:** Return the queued snapshot captured during insertion; a post-commit read could incorrectly return a running job with `201`.
- **Recovery consuming retry budget twice:** Keep recovery distinct from starting a new retry, especially when
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
