# Plan

## Approach
Keep the existing TypeScript entry points, npm commands, and single HTML page. Use `node:sqlite` for all persistent job state, retry scheduling, idempotency, and worker heartbeats; both processes initialize the same schema independently. The server handles validation and HTTP requests, while a sequential worker performs timed steps and commits each state transition. Use short transactions, asynchronous timers, and browser polling to keep progress observable and shutdown responsive.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, typed row mapping, and transactional job operations.
- `src/jobs.ts` (new): Define job and submission types, request validation, normalized payload comparison, and public job serialization.
- `src/server.ts`: Replace the placeholder routes with the HTTP API, HTML serving, error handling, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat updates, oldest-first claiming, timed processing, retries, restart recovery, and shutdown.
- `ui/index.html`: Add the submission form, accessible errors, job list, polling, and minimal styling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Establish the shared database schema.**
   - Preserve parent-directory creation, `DATABASE_PATH` default, and the existing ordering of `PRAGMA busy_timeout = 5000` before enabling WAL.
   - Initialize tables and indexes with `IF NOT EXISTS` from both entry points. Keep initialization transactions short so simultaneous startup works.
   - Store jobs with an internal integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, and an epoch-millisecond `available_at` for delayed retries.
   - Store a nullable unique idempotency key on each job. Immutable input/steps/fail-attempt columns provide the normalized payload for comparison; multiple `NULL` keys must be allowed.
   - Add a singleton worker heartbeat row containing its last-seen epoch milliseconds.
   - Use insertion sequence for deterministic newest-first listing and oldest-first claiming, including submissions with identical timestamps.
   - Centralize serialization so every endpoint returns exactly the specified public fields. Never expose scheduling or database metadata. Construct `progress.total` from `steps`, and expose result/error only for their corresponding terminal status.

2. **Implement complete submission validation before any database mutation.**
   - Read the request body asynchronously and parse JSON with controlled error handling.
   - Accept the media type `application/json`, case-insensitively, including parameters such as `charset=utf-8`; reject missing or different content types with a `"body"` field error.
   - Require a non-null, non-array JSON object. Malformed JSON and invalid root values produce `"body"` errors.
   - Inspect all own keys and collect unknown-field errors alongside errors for every invalid known field.
   - Require a string input with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Store the original string without trimming.
   - Apply defaults only when optional properties are absent. Explicit `null`, strings, booleans, fractional numbers, and out-of-range values remain invalid.
   - Validate the optional idempotency header against `^[A-Za-z0-9_-]{1,128}$`; reject empty or ambiguous duplicate values and name `"Idempotency-Key"` in errors.
   - Return `400` with `error.code = "invalid_request"`, a useful message, and an array of `{field, message}` entries. Collect independent header errors even when body validation fails.

3. **Implement transactional creation and idempotency.**
   - Use a short `BEGIN IMMEDIATE` transaction for lookup, comparison, and insertion; rollback on exceptions.
   - For an existing key, compare exact input and defaulted numeric values. Return its current job representation with `200` when equal, or `409 idempotency_conflict` when different.
   - For a new submission, assign `crypto.randomUUID()`, set queued status, attempts/progress to zero, null output/error, and equal initial timestamps; insert and commit before responding `201`.
   - Capture the inserted queued representation inside the transaction. Do not reread after commit for the creation response, since the worker could already have claimed the job.
   - Enforce uniqueness in SQLite as well as in application logic. Invalid submissions and conflicts must neither create jobs nor reserve keys.

4. **Implement the HTTP route contract.**
   - Match pathname independently of method, then apply the allowed methods:
     - `/`: GET serves the existing HTML location using `new URL('../ui/index.html', import.meta.url)`, which also works from `dist/server.js`.
     - `/health`: GET reads the heartbeat and returns `"up"` only when it exists and is no more than 3000 ms old.
     - `/api/jobs`: GET lists all jobs newest first; POST uses the validated transactional submission flow.
     - `/api/jobs/:id`: GET returns the job or `404 not_found`.
   - Return `405 method_not_allowed` for unsupported methods on recognized paths, including a job detail path whose ID does not exist. Optionally include `Allow`.
   - Return `404 not_found` for other paths. Avoid accidentally recognizing paths with extra segments.
   - Use one JSON response helper for all API responses and errors. Catch asynchronous handler failures and return a structured `500` without leaking database details; log operational failures.
   - Keep the configured/default port and existing startup command working.

5. **Implement worker scheduling and processing.**
   - Write a heartbeat immediately after initialization and refresh it about every 500 ms, including during idle periods, step delays, and retry waits.
   - Poll for work every 100 ms. In a short transaction, select the oldest queued job whose `available_at <= now`, mark it running, increment attempts, reset progress to zero, clear output/error, and update its timestamp.
   - Process one job at a time. Never hold a transaction across a timer.
   - Before each step finishes, await approximately 100 ms using asynchronous timers.
   - If the current attempt number is at most `failAttempts`, fail after the first step delay but before recording any progress:
     - Attempts 1–2: atomically return the same job to queued, leave progress zero and result/error null, and set `available_at = now + 500 ms`.
     - Attempt 3: atomically mark failed, set error to `"transient failure"`, and leave result null.
   - Otherwise, commit each finished step and update `updatedAt`. On the final step, atomically set completed status, full progress, and output computed by JavaScript `input.toUpperCase()`.
   - During a retry delay, other eligible jobs may run. Among eligible jobs, retain original insertion order.
   - Never select completed or failed jobs.

6. **Handle recovery and shutdown explicitly.**
   - The task requires one worker process. On worker startup, recover any persisted running job before claiming queued jobs; the server must never perform worker recovery.
   - Treat crash recovery as continuation of the already-counted, interrupted attempt: keep `attempts`, reset its progress to zero, and replay that attempt from the first step. This avoids inventing a transient failure or exceeding three attempts when a worker dies during attempt 3.
   - Apply the same failure predicate to the recovered attempt. Subsequent genuine retries increment attempts normally.
   - Preserve queued retry deadlines across restarts. A fresh worker should begin recovery immediately, well within the required ten seconds.
   - On worker `SIGTERM`/`SIGINT`, stop taking work, interrupt or finish the current short timer, and leave an unfinished job running for recovery. Clear heartbeat timers, invalidate the heartbeat, close SQLite, and exit without pending timers.
   - On server shutdown, stop accepting requests, allow active handlers to finish, then close SQLite. Use bounded connection cleanup so a stalled client cannot prevent exit.
   - After `SIGKILL`, rely on committed SQLite state and heartbeat expiry; no cleanup handler is assumed to run.

7. **Build the browser page.**
   - Add a form with all required test IDs, labeled input/steps/fail-attempt fields, defaults `5` and `0`, and a submit button.
   - Use `novalidate` so browser constraints do not suppress API validation. Convert numeric field values using `Number` without truncation; send blank numeric values as `null` so invalid entries are not silently defaulted or converted to zero.
   - POST JSON to `/api/jobs`. Clear `form-error` before a submission and after success. On rejection, show the API message plus every offending field name and its message in the `role="alert"` region.
   - Render the job list newest first, with one `job-item` carrying `data-job-id` per job. Include exact status text, `completed/total`, and output/error/empty result text according to status.
   - Use DOM APIs and `textContent` for submitted text, results, and errors.
   - Fetch the list on load, after successful submission, and approximately every 500 ms. Serialize refreshes or discard stale responses so older polls cannot overwrite newer state.
   - Keep polling after transient network errors without overwriting form validation messages. Polling must not replace the form or disturb entered values.

8. **Build and verify without changing fixed files.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The supplied checks cover only basic startup, submission, selected validation, completion, one retry, and idempotency. Supplement them with temporary local scripts using Node built-ins and manual browser checks.
   - Use isolated temporary databases and ports for supplementary checks; test both process startup orders and simultaneous startup.

## Behaviours to verify
- **Public job shape:** Submit with the worker stopped; inspect `201`, detail, and list responses for queued status, defaults, zero attempts/progress, null result/error, ISO timestamps, and no internal fields.
- **Validation:** Exercise malformed/empty JSON, primitive/array/null roots, missing/non-JSON content types, numeric strings, null optional values, numeric bounds/fractions, whitespace-only input, long input, multiple unknown fields, and invalid keys. Assert every relevant field is named and job count stays unchanged.
- **Exact text handling:** Submit padded text and Unicode text; confirm stored input is unchanged, length follows JavaScript semantics, and output matches JavaScript uppercasing.
- **Routing:** Check every known path with unsupported methods, unknown paths, and missing IDs; verify status, JSON content type, and error code.
- **Idempotency:** Replay omitted versus explicit defaults, vary property order, change each payload field, send concurrent same-key requests, and restart the server. Assert one persistent job per key and distinct jobs without keys.
- **Ordering and timing:** Queue multiple jobs before starting the worker; observe oldest-first processing and newest-first listing. Poll a 20-step job frequently to observe incremental progress and pickup within one second.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify attempt totals 1, 2, 3, 3, and 3, appropriate terminal states, zero failed-attempt progress, a visible delayed queued state, and no duplicate jobs.
- **Health:** Check server-only `"down"`, startup `"up"`, continued `"up"` during long jobs/retries, and `"down"` within three seconds after killing the worker.
- **Durability:** Restart both processes using the same database after graceful stops and `SIGKILL`. Preserve terminal jobs and idempotency keys; recover a running long job, including one interrupted on attempt 3, and preserve delayed retries.
- **Shutdown/startup:** Verify startup under ten seconds wi
[truncated]