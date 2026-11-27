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
Implement the tracker with Node.js built-ins, keeping the existing server and worker entry points and npm commands. Both processes initialize and use the same SQLite schema; all jobs, retry scheduling, idempotency keys, and worker heartbeats live in the database. Use short atomic database transactions and asynchronous worker delays so HTTP reads can observe progress. Serve a self-contained browser page that submits jobs and polls the API every 500 ms.

## Files
- `src/db.ts`: Extend the existing database initializer with the shared schema, transaction helpers, and database configuration.
- `src/jobs.ts` (new): Define job types, row serialization, submission/idempotency operations, ordered reads, and worker state transitions.
- `src/validation.ts` (new): Validate request bodies and idempotency keys, apply defaults, and produce field errors.
- `src/server.ts`: Implement routing, request parsing, API responses, health checks, page serving, and shutdown.
- `src/worker.ts`: Implement heartbeat updates, sequential processing, persisted retries, recovery, and shutdown.
- `ui/index.html`: Implement the form, error region, job list, polling, and minimal styling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Create the shared schema and database helpers.**
   - Preserve directory creation and the existing order of `busy_timeout = 5000` before enabling WAL. Use `CREATE TABLE/INDEX IF NOT EXISTS` so either process can initialize the database first.
   - Create a `jobs` table containing:
     - Internal integer insertion sequence for deterministic ordering.
     - Unique public string ID generated with `randomUUID()`.
     - `input`, `steps`, `fail_attempts`, `status`, `attempts`, `completed_steps`, nullable output and error, ISO creation/update timestamps.
     - Nullable unique `idempotency_key` and numeric `available_at` timestamp for retry eligibility.
   - Store idempotency keys directly on job rows: SQLite permits multiple `NULL` values in a unique column, so unkeyed submissions remain independent.
   - Create a singleton worker-state table with the last heartbeat timestamp. A missing heartbeat means down.
   - Provide a synchronous transaction wrapper using `BEGIN IMMEDIATE`, `COMMIT`, and rollback on failure. Never hold a transaction across an asynchronous wait.
   - Centralize serialization into the exact public job shape; omit internal fields, derive `progress.total` from `steps`, and expose result/error only for their corresponding terminal statuses.

2. **Implement comprehensive submission validation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` error.
   - Read the complete request body and parse JSON. Empty/malformed JSON, `null`, arrays, and primitives produce a `"body"` error.
   - For objects, collect every offending field rather than returning on the first error. Check unknown own properties as well as all three supported fields.
   - Require `input` to be a string with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Preserve the original string.
   - Apply numeric defaults only when the property is absent. Reject explicit `null`, strings, booleans, fractions, and values outside the specified ranges.
   - Validate a present `Idempotency-Key` against the exact regex, including rejecting an empty value. Report its error as `"Idempotency-Key"`; combine it with any independently detectable body errors.
   - Return a normalized payload only when validation succeeds. No database mutation occurs for rejected requests.

3. **Make creation and idempotency atomic.**
   - Within one immediate transaction, look up a supplied key and compare its job’s immutable `input`, `steps`, and `failAttempts` against the normalized payload.
   - Return the existing job with `200` for equality or `409 idempotency_conflict` for a difference.
   - Otherwise insert one queued job with attempts/progress zero, null result/error, and matching creation/update timestamps.
   - Capture the inserted job representation before releasing the transaction and return it with `201`. This guarantees the creation response describes a queued job even if the worker immediately claims it.
   - Keep the unique constraint as a database-level safeguard against duplicate keyed submissions across concurrent requests and restarts.

4. **Implement the HTTP routes and lifecycle.**
   - Match URL paths independently of methods, then enforce the allowed methods:
     - `/`: GET HTML.
     - `/health`: GET health JSON.
     - `/api/jobs`: GET list or POST submission.
     - `/api/jobs/:id`: GET one job.
   - Return `405 method_not_allowed` for wrong methods on recognized routes, optionally with `Allow`; return `404 not_found` for unknown paths and missing jobs.
   - List jobs by insertion sequence descending. Decode single-segment job IDs safely; malformed paths must not crash the handler.
   - Use one JSON response helper and a consistent error envelope. Include `fields` on every `invalid_request` response.
   - Determine worker health from a heartbeat no more than 3000 ms old.
   - Preserve the existing HTML resolution through `new URL('../ui/index.html', import.meta.url)`, which works from compiled `dist/server.js`.
   - Catch asynchronous request failures so malformed input or aborted uploads cannot create unhandled rejections. Unexpected failures receive a JSON server error when a response is still possible.
   - On SIGTERM/SIGINT, stop accepting connections, drain active requests with a bounded shutdown deadline, close remaining connections if necessary, and close SQLite.

5. **Implement sequential processing and durable retries.**
   - Write a heartbeat immediately at startup and refresh it every 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms. Atomically select and claim the oldest eligible queued job using insertion sequence and `available_at <= now`.
   - Starting a new attempt sets `running`, increments attempts, resets completed steps to zero, clears result/error, and updates `updatedAt`.
   - Wait approximately 100 ms for each step. If this is the first step and `attempts <= failAttempts`, fail before incrementing progress.
   - For a simulated failure with attempts below three, atomically return the same job to queued with zero progress, null result/error, and `available_at = now + 500 ms`.
   - At the third simulated failure, atomically mark failed with exactly `"transient failure"` and null result.
   - For successful steps, persist progress and `updatedAt` individually. On the last step, atomically publish completed status, full progress, and `input.toUpperCase()`.
   - Do not sleep while holding database locks. During a retry delay, other eligible jobs may run; choose the oldest eligible job each time.

6. **Recover interrupted work without losing retry accounting.**
   - Assume the specified single worker process; do not add a distributed worker coordination system.
   - At worker startup, recover persisted running work before claiming ordinary queued work. Replay the interrupted attempt from step zero while preserving its already-started attempt number. This recovery continues the durable attempt rather than allocating a fourth attempt after a crash during attempt three.
   - Reset progress atomically for replay, retain the running status, and apply the same first-step failure rule using the persisted attempt number.
   - Keep failure-to-queued and final completion transitions atomic, so a crash cannot leave half-published retry or result state.
   - Preserve queued jobs’ retry timestamps across restarts. Never select completed or failed jobs.
   - On SIGTERM/SIGINT, stop claiming work and exit after the current short sleep/database operation. Leave an interrupted job running for startup recovery, stop heartbeat updates, clear the heartbeat, and close SQLite.
   - A SIGKILL requires no cleanup: stale heartbeat expiry reports down, and persisted running state drives recovery on restart.

7. **Build the browser page against the API.**
   - Add all required `data-testid` attributes verbatim. Each `job-item` must have its public ID in `data-job-id` and contain its own status, progress, and result elements.
   - Use a text area for input, numeric controls initialized to 5 and 0, a submit button, and an initially empty `form-error` with `role="alert"`.
   - Use `novalidate` so browser constraint validation does not prevent API errors from reaching the page.
   - Send the input unchanged and numeric controls as JSON numbers. Do not silently replace invalid/empty numeric entries with defaults; send a value the API rejects, such as `null` for an empty control.
   - Clear the error region when a new submission starts and on success. On API rejection, show its message and every field name/message. Keep polling errors separate so refreshes do not erase submission errors.
   - Fetch jobs on page load, immediately after a successful submission, and every 500 ms. Serialize refreshes or discard stale responses to avoid older snapshots overwriting newer ones.
   - Render in API order with status text, `completed/total`, and output/error only when terminal. Use DOM creation and `textContent` for submitted strings and results.

## Behaviours to verify
- **Existing commands:** After implementation, run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. These checks cover examples, not the entire specification.
- **Startup and health:** Start each process first in separate trials with a fresh nested `DATABASE_PATH`. Confirm startup within 10 seconds, down without a worker, up while idle and busy, and down within about 3 seconds of worker SIGKILL.
- **Validation:** Exercise missing input, whitespace, Unicode length boundaries, unknown fields, multiple simultaneous errors, explicit nulls, numeric strings, fractions, out-of-range numbers, malformed JSON, non-object bodies, incorrect content types, and invalid keys. Verify `fields` and unchanged job count.
- **Idempotency:** Test omitted versus explicit defaults, changed values, unkeyed duplicates, simultaneous same-key requests, and replay after server restart. Verify one durable job per key and the correct 201/200/409 responses.
- **Processing:** Poll a 20-step job frequently enough to observe running progress. Verify one active job, oldest eligible pickup, step timing, exact preserved input, and JavaScript Unicode uppercase output.
- **Retries:** Test `failAttempts` 0 through 5. Expect attempts 1, 2, and 3 for eventual success with values 0, 1, and 2; values 3–5 must fail after exactly three attempts. Observe queued retry intervals and zero progress on failed attempts.
- **Durability:** Stop both processes gracefully and with SIGKILL, then restart using the same database. Check retained IDs, terminal states, idempotency records, and queued retry schedules. Kill the worker during a long attempt, including successful attempt three, and verify recovery without duplicate jobs or exceeding the attempt budget.
- **Routing and shutdown:** Check wrong methods on every known route, missing IDs, unknown paths, JSON content types/error envelopes, and clean SIGTERM exits for both processes.
- **Browser:** Inspect all required selectors, submit valid and invalid forms, confirm field names appear in the alert, and watch progress/terminal changes within 2 seconds. Reload to verify durable jobs reappear; submit HTML-like input to confirm it renders as text.

## Risks
- **Database contention:** Keep transactions short, configure the busy timeout before WAL, and initialize schema from both processes.
- **Ordering ties:** Millisecond timestamps can collide; use the insertion sequence for newest/oldest ordering.
- **Crash versus simulated failure:** A process interruption must not become an invented transient failure. Preserve the interrupted att
[truncated]

## Rules

- Work only inside this repository. Do not modify anything under `checks/` or the files listed as fixed in the task.
- You may read files, edit files, and run local commands. Network access is not needed; dependencies are already installed.
- You have at most 25 minutes. Work that is not saved to the repository when time runs out is lost.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
