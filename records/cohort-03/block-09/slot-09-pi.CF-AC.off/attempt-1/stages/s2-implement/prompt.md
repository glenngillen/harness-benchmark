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
Use the existing TypeScript entry points, Node.js built-ins, and a shared SQLite database; keep the current commands and file layout intact. Centralize schema initialization, job serialization, and transactional state changes so either process can start first. The server handles HTTP and the browser page, while the worker independently polls SQLite and persists progress, retries, and heartbeats. Keep transactions short and never hold a database lock during a processing delay.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactions, and job serialization.
- `src/jobs.ts`: Create shared job/payload types, validation, default application, and normalized payload comparison.
- `src/server.ts`: Replace the placeholder with API routing, request parsing, idempotent submission, health reporting, HTML serving, and shutdown handling.
- `src/worker.ts`: Replace the placeholder loop with durable processing, retries, restart recovery, heartbeat updates, and shutdown handling.
- `ui/index.html`: Implement the submission form, error region, job list, polling, and lightweight styling.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Define the shared database schema and public representation.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL configuration.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both processes.
   - Store jobs with an internal integer sequence for deterministic ordering; a unique public UUID; input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, creation/update timestamps, and retry eligibility time.
   - Store the nullable idempotency key with a unique constraint and the normalized submitted payload alongside the job. Multiple jobs without keys must remain allowed.
   - Add a singleton worker-heartbeat record storing epoch milliseconds.
   - Use one serializer everywhere to emit exactly the specified job shape, excluding internal fields. Derive `progress.total` from `steps` and expose output as `{output}` only for completed jobs.
   - Use ISO timestamps for public timestamps, update `updatedAt` on every job transition/progress write, and order lists by sequence descending and processing by sequence ascending.

2. **Implement complete validation before any insertion or replay lookup.**
   - Accept `application/json` case-insensitively with optional parameters, such as `charset=utf-8`; reject missing or different media types with a `"body"` error.
   - Read the complete request body and catch malformed JSON. Require a non-null, non-array JSON object.
   - Collect errors for every unknown property and every invalid supplied field. Use own-property checks so absent fields receive defaults but explicit `null` does not.
   - Require `input` to be a string with JavaScript length 1–1000 and nonempty `trim()`, preserving its original value.
   - Require numeric integer `steps` in 1–20 and `failAttempts` in 0–5; default only omitted values to 5 and 0.
   - Validate any supplied `Idempotency-Key` against the exact regex and report errors using that field name.
   - Aggregate independently detectable header and payload errors. For an unparseable or non-object body, report `"body"` rather than inventing missing-field errors.
   - Normalize successful payloads into a fixed property order for comparison, without trimming or otherwise transforming input.

3. **Implement the API with durable, atomic idempotency.**
   - Retain the existing HTML resolution through `new URL('../ui/index.html', import.meta.url)`, which also works from `dist/server.js`.
   - Route by pathname first, then method: `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`. Return JSON `405 method_not_allowed` for unsupported methods on recognized paths and JSON `404 not_found` for unknown paths or missing jobs.
   - Use a shared response/error helper. Every API response, including failures, has JSON content type; every validation error includes `fields`.
   - For submission, execute a short `BEGIN IMMEDIATE` transaction:
     - If the key exists, compare normalized payloads and return the current original job with 200, or conflict with 409.
     - Otherwise generate a UUID and insert the queued job with zero attempts/progress, null result/error, and immediate eligibility.
     - Capture the new job’s queued representation inside the transaction and return it with 201 after commit. Do not reread after commit, when the worker might already have claimed it.
   - Roll back on exceptions. Keep the database uniqueness constraint as the final protection against duplicate keyed jobs.
   - Implement list and detail reads through the shared serializer.
   - `/health` returns worker `"up"` only when the persisted heartbeat is at most 3 seconds old; missing/stale heartbeat means `"down"`.
   - Catch asynchronous request failures so malformed requests cannot crash the server or produce unhandled rejections.

4. **Implement worker processing and retry scheduling.**
   - Publish a heartbeat immediately at startup and approximately every 500 ms, including while idle, processing, or waiting for retries.
   - Poll for eligible queued work every 100 ms. Select the oldest eligible job, skipping queued retries whose eligibility time has not arrived.
   - Claim a job atomically in a short transaction: set `running`, increment attempts, reset completed steps to zero, clear output/error, and update its timestamp.
   - Process only one job at a time. Await approximately 100 ms per step, then commit that step’s progress.
   - At the first step, before recording progress, simulate failure when `attempts <= failAttempts`.
   - For failed attempts 1 and 2, persist `queued`, zero progress, null result/error, and an eligibility timestamp 500 ms ahead. Keep the delay in SQLite so restarting does not erase it.
   - On the third simulated failure, atomically persist `failed`, error `"transient failure"`, null output, and attempts 3.
   - On successful final processing, atomically persist final progress, `completed`, and JavaScript `input.toUpperCase()` output. Do not use SQLite’s uppercase function, whose Unicode behavior differs.
   - Never select completed or failed jobs.

5. **Handle restart recovery and clean shutdown explicitly.**
   - Under the task’s single-worker model, recover persisted running work before claiming newly queued work at worker startup.
   - Restart the interrupted durable attempt from progress zero, retaining its attempt number: this is recovery of that attempt, not an additional simulated-failure retry. Apply the same first-step failure rule afterward. This also allows an interrupted successful third attempt to finish without inventing a fourth retry.
   - Preserve queued retry eligibility times and all terminal jobs. Recovery must not depend on the server being alive.
   - On worker `SIGTERM`/`SIGINT`, stop claiming work, stop at a step boundary, clear heartbeat, and close SQLite in `finally`. Leave interrupted work durably recoverable.
   - On server shutdown, stop accepting requests, allow active handlers to settle, close connections within a bounded grace period, then close SQLite.
   - Abrupt death requires no cleanup: committed SQLite state survives, and the heartbeat naturally expires. Do not delete or recreate the database or WAL files on startup.

6. **Build the browser page around the API contract.**
   - Provide all required `data-testid` attributes exactly, with `form-error` carrying `role="alert"` and initially empty.
   - Supply defaults of 5 and 0 in the numeric fields. Disable native constraint validation with `novalidate` so API rejections are displayed rather than intercepted by the browser.
   - Submit the exact text input and numeric conversions of the numeric fields. Avoid `parseInt`, which silently accepts fractions or trailing junk; ensure blank numeric fields become invalid values rather than silently becoming zero.
   - Clear the error region on a new submission and keep it empty after success. For API rejection, display the message and every offending field name/message.
   - Fetch jobs on load, immediately after successful submission, and approximately every 500 ms using a non-overlapping polling loop.
   - Render newest first, with one `job-item` per ID and exact status, `completed/total`, and result/error text. Keep result empty for queued/running jobs.
   - Use DOM creation and `textContent` for user-derived content. Keep polling updates separate from form fields so typing and focus remain stable.
   - Handle fetch failures without stopping subsequent polling; prevent stale overlapping responses from replacing newer state.

7. **Build and verify the complete implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Supplement the supplied checks with local HTTP, restart, timing, and browser exercises below; the existing checks explicitly omit substantial parts of the contract.
   - Keep any additional source-based verification helpers under `src/` if retained. Do not edit the supplied checks or configuration files.

## Behaviours to verify
- **Startup and configuration:** Start each process first, then start both simultaneously using a fresh nested `DATABASE_PATH`; verify readiness within 10 seconds and default/custom ports.
- **Representation and ordering:** Submit several jobs rapidly, verify deterministic newest-first listing, initial queued snapshots, exact field types/defaults, and identical shapes across create/replay/detail/list.
- **Validation:** Exercise malformed JSON, arrays/null/scalars, missing or wrong content type, empty/whitespace/overlong input, Unicode string lengths, unknown fields, numeric strings, fractions, bounds, explicit nulls, and invalid keys. Combine invalid fields and verify all names appear and job count is unchanged.
- **Idempotency:** Replay with omitted versus explicit defaults, change each payload field, submit concurrent requests with one key, and replay after server restart. Confirm one ID/job per key and distinct jobs without keys.
- **Processing and timing:** Poll a 20-step job frequently; observe running status and increasing persisted progress. Verify idle pickup within 1 second and approximately 100 ms steps.
- **Retries:** Exercise `failAttempts` 0, 1, 2, 3, and 5. Verify attempt counts, zero progress during simulated failures, observable queued retry delays, successful third attempt for 2, and exact terminal error for 3 or more.
- **Durability:** Kill the worker during a running job, including a successful third attempt; restart against the same file and verify recovery. Stop both processes with SIGTERM and SIGKILL, restart, and verify IDs, keys, terminal results, and delayed retries remain intact.
- **Health and shutdown:** Observe worker up while idle and busy, down within 3 seconds after SIGKILL, and up after restart. Verify SIGTERM exits both processes promptly without database errors.
- **Browser:** Verify all selectors and nesting, submission, field-specific rejection messages, newest-first ordering, live progress/results within 2 seconds, and safe display of input resembling HTML.
- **Routing:** Check unknown paths, missing IDs, query strings, and wrong methods on every recognized route; verify JSON error codes and content types.

## Risks
- **Database locking:** Keep claims, idempotency checks/inserts, and transitions transactional but brief; never await inside a transaction. Preserve WAL and busy-timeout initialization.
- **Recovery attempt accounting:** Treat crash recovery consistently as replay of the persisted interrupted attempt; do not reset failure history or strand a running third attempt.
- **In-memory scheduling:** Persist retry deadlines and progress; memory-only timers cannot provide restart durability.
- **Heartbeat starvation:** Use asyn
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
