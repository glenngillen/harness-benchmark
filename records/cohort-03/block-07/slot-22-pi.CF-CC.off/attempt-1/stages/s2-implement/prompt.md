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
Use Node.js built-ins and the existing server, worker, and UI entry points. Initialize the same SQLite schema from either process, with durable jobs, idempotency keys, retry scheduling, and worker heartbeat state. Keep database transactions short; the worker waits asynchronously between steps and commits each progress update. Serve a small browser page that submits through the API and polls for job changes.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, prepared queries, transactions, and job serialization.
- `src/jobs.ts` (new): Define job/payload types, submission validation, and normalized payload comparison.
- `src/server.ts`: Implement API routes, JSON errors, request parsing, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, persisted retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Add the submission form, error region, job list, styles, and browser JavaScript.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Establish shared storage.**
   - Retain parent-directory creation and `busy_timeout` before WAL setup in `openDatabase`.
   - Run idempotent `CREATE TABLE IF NOT EXISTS` statements from both processes.
   - Store jobs with an integer insertion sequence, unique server-generated UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, normalized payload, and retry eligibility timestamp.
   - Use the insertion sequence for deterministic oldest/newest ordering, including jobs created in the same millisecond.
   - Add a singleton worker-heartbeat row storing a timestamp in milliseconds.
   - Centralize conversion from SQLite rows to the exact public job shape. Exclude internal scheduling/key fields; derive `progress.total` from `steps`, expose output only for completed jobs and error only for failed jobs.
   - Use parameterized statements and a transaction helper that always rolls back on errors. Never hold a transaction across an `await`.

2. **Implement validation before database mutation.**
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Collect request bytes, decode UTF-8 once, and parse JSON with handled errors. Reject empty/malformed JSON, arrays, `null`, and primitives as `"body"` errors.
   - Inspect own keys and report each unknown field. Validate all known fields without numeric coercion.
   - Require `input` to be a string of JavaScript length 1–1000 whose trimmed value is nonempty; preserve the original string.
   - Apply defaults only when `steps` or `failAttempts` is absent, never when explicitly `null`. Require integers in the specified ranges.
   - Validate a present `Idempotency-Key` against the full required expression, including rejecting empty or duplicate header values. Name its error field `"Idempotency-Key"`.
   - Return all detectable offending fields together in `400 invalid_request`; do not stop after the first field error. For an unparseable body, still include an independently invalid idempotency header.
   - Normalize valid payloads into a fixed-key-order representation of `{input, steps, failAttempts}`.

3. **Implement atomic submissions and job reads.**
   - For `POST /api/jobs`, begin an immediate transaction after validation. If a supplied key exists, compare normalized payloads and return either the original job with `200` or `409 idempotency_conflict`.
   - Otherwise generate an ID with `crypto.randomUUID()` and insert the queued job with attempts/progress zero, null output/error, and matching creation/update timestamps.
   - Read the inserted row within the transaction and retain that snapshot for the `201` response, ensuring it reports `queued` even if the worker claims it immediately afterward.
   - Enforce key uniqueness in SQLite as well as in application logic. Commit the key and job together so concurrent requests and server restarts cannot create duplicates.
   - Implement list ordering by descending insertion sequence and individual lookup by ID. Requests without keys always insert new rows.

4. **Complete routing and server lifecycle.**
   - Classify known paths before checking methods: `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment.
   - Serve HTML for `GET /`; use the existing `new URL('../ui/index.html', import.meta.url)` approach, which works from `dist/server.js`.
   - Return JSON `404 not_found` for unknown paths or missing jobs, and JSON `405 method_not_allowed` for unsupported methods on known routes. Include an appropriate `Allow` header.
   - Give every API/error response the required envelope and `application/json` content type. Catch asynchronous handler failures so requests cannot crash the server or hang.
   - Compute worker health from the persisted heartbeat: up only when its age is at most 3000 ms. Server startup must not overwrite heartbeat state.
   - Respect `PORT`, defaulting to 3000. Retain the server handle, stop accepting connections on SIGTERM/SIGINT, close idle connections, finish active work within a bounded grace period, and then close SQLite.

5. **Implement the worker state machine.**
   - Open/initialize SQLite independently of the server. Write an initial heartbeat and refresh it every approximately 500 ms, including while idle, processing, and waiting for retries.
   - Poll for work every approximately 100 ms. In a short transaction, select the oldest queued job whose eligibility time has arrived, then mark it running, increment attempts, reset progress to zero, clear output/error, and update its timestamp.
   - Process one job at a time. Wait approximately 100 ms before each step; commit each completed step separately so API reads observe intermediate progress.
   - On an attempt whose number is at most `failAttempts`, fail after the first step’s delay but before recording any progress.
   - For transient failures on attempts 1 or 2, atomically return the job to queued with a persisted eligibility time approximately 500 ms later, zero progress, and null result/error. The worker may process other eligible jobs while that job waits.
   - On the third transient failure, atomically set failed, attempts 3, progress zero, null output, and error `"transient failure"`.
   - On a successful last step, atomically write the final progress, completed status, and `input.toUpperCase()` output. This avoids a crash gap between final progress and completion.
   - Update `updatedAt` on every job mutation while preserving `createdAt`.

6. **Handle restart and shutdown explicitly.**
   - Before claiming queued work, recover any running job left by the previous worker. Under the specified single-worker model, startup can identify this directly without waiting for a lease expiry.
   - Replay the interrupted attempt from step zero using its already-persisted attempt number; treat this as recovery of that unfinished attempt, not a new transient-failure retry. This preserves the three-attempt limit even if the worker dies during attempt 3.
   - Apply the same failure test and completion logic during recovery. Only an actual transition from queued to a new attempt increments attempts.
   - Preserve queued retry deadlines across restarts. Never reset or select completed/failed jobs for processing.
   - On SIGTERM/SIGINT, stop claiming work, cancel or finish the short pending step wait, stop heartbeat updates, clear the heartbeat, and close the database. Leave unfinished running work durable for restart recovery.
   - SIGKILL requires no cleanup: the heartbeat naturally expires, committed progress survives, and startup recovery handles unfinished work.

7. **Build the browser page.**
   - Add every required `data-testid`, including `form-error` with `role="alert"` and each `job-item` with `data-job-id`.
   - Use a textarea for input and numeric fields initially containing `5` and `0`. Use `novalidate` on the form so browser constraints do not hide API validation responses.
   - Submit input unchanged and numeric field values as numbers. Treat blank or invalid numeric text as an invalid value such as `null`, rather than accidentally converting blank input to zero or silently applying defaults.
   - Clear the error region for a new submission and after success. On API rejection, show the error message and every returned field name/message.
   - Fetch the list immediately and refresh approximately every 500 ms using a non-overlapping polling loop; refresh after successful submission.
   - Render newest first, status text, `completed/total`, and output/error according to status. Use DOM APIs and `textContent` for submitted input and output.
   - Keep the previous list visible after a temporary polling failure, and continue polling. Keep network failures distinct from successful empty responses.

## Behaviours to verify
- **Existing commands and compilation:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The supplied checks cover only part of the requirements.
- **Startup independence:** Use a fresh nested `DATABASE_PATH`; start worker first, server first, and both together. Confirm startup within 10 seconds and automatic parent-directory creation.
- **Validation:** Exercise malformed JSON, missing/wrong content type, non-object bodies, unknown fields, nulls, numeric strings, fractions, boundaries, whitespace-only input, and invalid keys. Submit several bad fields together; verify every field is named and job count is unchanged.
- **Exact input handling:** Submit surrounding whitespace and Unicode, including characters whose uppercase output changes length. Confirm stored input remains exact and output matches JavaScript `toUpperCase()`.
- **Idempotency:** Compare omitted defaults with explicit defaults; issue concurrent same-key requests; test conflicts, restart the server, and replay again. Verify one durable job per key and new jobs for keyless submissions.
- **Processing and retries:** Poll a 20-step job frequently to observe running state and intermediate progress. Test `failAttempts` 0 through 5; verify success on attempts 1–3 or failure at exactly 3, queued retry delays, and no duplicate jobs.
- **Ordering:** Queue several jobs with the worker stopped, then start it. Verify oldest eligible jobs run first and listing remains newest first.
- **Health:** Check up while idle and active; SIGKILL the worker and confirm down after the three-second freshness window, then up after restart.
- **Durability:** Restart both processes against the same file after graceful stops and SIGKILL. Kill the worker mid-attempt, including attempt 3, and during retry waiting. Confirm recovery within the specified bound and unchanged terminal jobs.
- **HTTP routing:** Check all documented methods, unsupported methods on known paths, unknown paths, missing IDs, JSON error envelopes, and content types.
- **Browser contract:** Inspect all test IDs, submit valid and invalid jobs, verify field names in alerts, observe progress/results without reload within two seconds, and confirm HTML-like input displays as text.
- **Shutdown:** Signal the actual Node processes, including during idle and processing states; verify prompt exit, released database handles, and restartability.

## Risks
- **SQLite races and locks:** Keep WAL and busy timeout configuration, atomic keyed insertion, transactional claims, and short writes. Do not sleep inside transactions.
- **Restart semantics:** Distinguish replaying an interrupted attempt from starting a retry; otherwise crashes can consume or exceed the three-attempt budget.
- **Heartbeat staleness:** Refresh independently of job progress so idle workers and retry waits remain healthy; never infer liveness from run
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
