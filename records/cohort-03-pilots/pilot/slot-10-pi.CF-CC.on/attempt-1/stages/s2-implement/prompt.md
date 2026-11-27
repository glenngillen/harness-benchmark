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
Use Node.js built-ins and the existing TypeScript entry points, with SQLite as the only communication channel between server and worker. Initialize the same schema from either process, store every job transition durably, and use short transactions for submission and job claiming. Run one worker processing one job at a time, with persisted retry deadlines and a database heartbeat. Build the browser page with plain HTML and JavaScript that submits to the API and polls for updates.

## Files
- `src/db.ts`: Extend database initialization with shared schema, prepared queries, transactions, and job serialization.
- `src/jobs.ts`: Add shared job/payload types and submission validation.
- `src/server.ts`: Implement routing, JSON responses, submissions, idempotency, health, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, oldest-first processing, observable progress, retries, recovery, and shutdown.
- `ui/index.html`: Implement the form, errors, job list, and polling.
- Leave all fixed files and `checks/` unchanged. Preserve the existing build/start commands and source import conventions.

## Steps
1. **Define the database and public representation.**
   - Preserve parent-directory creation and the existing `busy_timeout` initialization before enabling WAL.
   - Initialize tables using `CREATE TABLE IF NOT EXISTS` in both processes.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric retry eligibility time.
   - Use the insertion sequence for deterministic oldest/newest ordering, including submissions created in the same millisecond.
   - Store worker heartbeat time in a separate singleton table. Schema initialization must not refresh the heartbeat.
   - Provide one serializer producing exactly the specified public shape; omit internal sequence, key, and retry metadata. Construct `progress.total` from `steps` and expose output only as `{ output }` for completed jobs.
   - Use parameterized SQL and rollback transactions on exceptions. Never hold transactions open during timers or request-body reads.

2. **Implement validation independently of persistence.**
   - Parse `Content-Type` case-insensitively, accepting `application/json` with optional parameters. Missing or different media types produce a `"body"` error.
   - Collect the complete request body before parsing JSON; malformed/empty JSON, arrays, `null`, and primitives produce a `"body"` error.
   - For objects, collect all unknown fields and all invalid recognized fields rather than returning after the first error.
   - Require a string input with JavaScript `.length` from 1 through 1000 and nonempty `.trim()`. Store the original string unchanged.
   - Apply defaults only when properties are absent. Explicit `null`, booleans, numeric strings, fractions, and out-of-range values must fail.
   - Validate `Idempotency-Key` against the exact required expression, reporting that field name. Reject duplicate header values rather than silently choosing one.
   - Combine detectable header/body/field errors into `400 invalid_request` with a required `fields` array. Perform no database mutation until validation succeeds.

3. **Implement submissions and idempotency atomically.**
   - Generate public IDs with `randomUUID()`.
   - In a short `BEGIN IMMEDIATE` transaction, look up a supplied key. Compare the existing job’s immutable input, steps, and failAttempts against the normalized payload.
   - Return the existing job with `200` when equal, or `409 idempotency_conflict` when different.
   - Otherwise insert a queued job with attempts/progress zero, null output/error, and matching initial timestamps. Persist the key on the same row, protected by its unique constraint.
   - Capture the inserted queued representation before committing, then return it with `201`; a worker claiming immediately afterward must not change the creation response to running.
   - A missing key always inserts a new job. Keys remain durable through terminal states and server restarts.

4. **Complete HTTP routing and lifecycle.**
   - Match pathname independently of method; then enforce the permitted methods. Known routes are `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment.
   - Serve the existing HTML location using `new URL('../ui/index.html', import.meta.url)` so it works from `dist/server.js`.
   - Implement list ordering by descending insertion sequence and individual lookup by public ID.
   - Return JSON errors for unknown paths (`404 not_found`) and wrong methods on recognized routes (`405 method_not_allowed`, optionally with `Allow`). A missing job on an otherwise valid GET returns `404`.
   - Centralize JSON headers and error envelopes. Catch asynchronous request failures so they cannot become unhandled rejections; unexpected failures receive a JSON server error.
   - Compute worker health from the stored heartbeat: up only when its age is at most 3000 ms; absent/stale means down.
   - Retain `PORT` default 3000 and the shared database configuration.
   - On SIGTERM/SIGINT, stop accepting connections, finish active requests, close the database after handlers finish, and exit. Bound shutdown for clients that leave requests open.

5. **Implement the worker state machine.**
   - Publish a heartbeat immediately after initialization and every approximately 500 ms while running, including during processing and retry waits.
   - Poll approximately every 100 ms when idle. In a short transaction, select the oldest eligible queued job and atomically set it running, increment attempts, reset progress to zero, and clear output/error. Preserve the original creation time.
   - Select using `available_at <= now`, ordered by insertion sequence; a delayed retry does not prevent processing other eligible jobs.
   - Sleep approximately 100 ms for each step using asynchronous timers. After each successful step, commit the new progress and updated timestamp.
   - On the first step, if the current attempt number is at most failAttempts, fail before recording progress:
     - Attempts 1–2: return the same job to queued with zero progress, null output/error, and a persisted eligibility deadline approximately 500 ms later.
     - Attempt 3: mark failed with exactly `"transient failure"`, null output, and zero progress.
   - On the final successful step, atomically persist completed status, full progress, and `input.toUpperCase()`. Do not create separate result records.
   - Maintain a single sequential processing loop; heartbeat callbacks must not claim or process work.

6. **Handle restarts and process termination explicitly.**
   - For the required single-worker deployment, inspect persisted running jobs before claiming fresh queued jobs on startup. Terminal jobs are never selected.
   - Replay an interrupted running job from step zero as recovery of its persisted attempt, retaining its attempt number. This avoids a crash during a successful third attempt causing an invented fourth retry or an unsupported terminal error; subsequent simulated failures still follow the three-attempt rules.
   - Persist the reset progress and updated timestamp before replay. Preserve queued retry deadlines across restarts.
   - On SIGTERM/SIGINT, stop claiming work, wake or cancel pending waits, and prevent further step writes after shutdown begins. Leave an interrupted job running for startup recovery.
   - Clear the heartbeat on graceful worker exit, stop timers, and close SQLite. After SIGKILL, health naturally becomes down once the heartbeat expires.
   - Recovery should begin immediately, comfortably within the ten-second recovery allowance.

7. **Build the browser interface.**
   - Include every specified `data-testid` exactly, including an always-present empty `form-error` with `role="alert"`.
   - Use a textarea for input, editable numeric fields initialized to 5 and 0, and a submit button inside `job-form`. Use `novalidate` so API validation and its errors remain observable.
   - Preserve input whitespace. Convert numeric field values to numbers; send invalid/empty numeric entries as an invalid value such as `null`, rather than silently substituting a default.
   - Submit JSON to `/api/jobs`. Clear the previous error when a new submission begins; display the API rejection message and every offending field name on failure. Handle network failures visibly.
   - Refresh the list immediately after successful submission and poll approximately every 500 ms, starting on page load. Use sequential refreshes or request sequencing so stale responses cannot overwrite newer state.
   - Render jobs in API order with `job-item` and `data-job-id`, status, exact `completed/total` progress, and output/error as specified.
   - Use `textContent` for user input, results, and errors. Updating the job list must not replace the form or erase a submission error.

8. **Build and verify the completed implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The disclosed checks cover only examples; perform the additional checks below using temporary databases and the existing commands. Do not modify the fixed checks or package scripts.

## Behaviours to verify
- **Startup/configuration:** Start worker first, server first, and both simultaneously against a missing nested database path. Both become ready within ten seconds; custom PORT and DATABASE_PATH work.
- **Representation and ordering:** Submit several jobs quickly; confirm exact response fields, queued creation snapshots, deterministic newest-first listing, unchanged input, and ISO timestamps.
- **Validation:** Exercise unknown fields, multiple simultaneous errors, missing input, whitespace, boundary lengths including surrogate pairs, numeric strings, nulls, fractional/out-of-range numbers, malformed JSON, arrays, missing/wrong media type, and invalid keys. Confirm all applicable fields are named and job count is unchanged.
- **Routes:** Check every supported method, wrong methods on each known route, unknown paths, and nonexistent IDs. Verify JSON content types and error codes.
- **Idempotency:** Compare omitted defaults with explicit defaults, change each payload field, replay after completion and restart, and issue concurrent submissions with one key. Confirm one durable job and appropriate 200/201/409 responses.
- **Processing:** Poll a 20-step job frequently enough to observe intermediate progress. Confirm pickup under one second when idle, approximately 100 ms steps, uppercase Unicode output, and one-at-a-time processing.
- **Retries:** Test failAttempts 0 through 5; expected terminal attempts are 1, 2, 3, 3, 3, 3. Observe queued retry waits, zero failure progress, null nonterminal errors, and no duplicate jobs.
- **Durability:** Kill the worker during partial progress, during a retry delay, and during a successful third attempt. Restart with the same database and confirm recovery, retained IDs, correct results, and no reprocessing of terminal jobs. Also restart both processes.
- **Health/shutdown:** Verify up while idle and busy, down after graceful exit or within three seconds of a killed worker’s last heartbeat, and prompt SIGTERM exits.
- **Browser:** Use the prescribed selectors to submit valid and invalid jobs, inspect field-specific alerts, observe progress/status updates within two seconds, and reload to see persisted jobs. Verify HTML-looking input renders as text.

## Risks
- **Crash recovery versus retry accounting:** Keep recovery of an interrupted attempt distinct from a retry after a recorded transient failure. Never decrement persisted attempts or consume another retry merely while initializing.
- **SQLite contention:** Preserve busy timeout before WAL initialization, keep write transactions short, and make schema initia
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
