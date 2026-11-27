# Plan

## Approach
Use the existing TypeScript entry points, Node.js built-ins, and a shared SQLite database for jobs, retry scheduling, idempotency, and worker heartbeats. Keep database operations synchronous and transactions short; use asynchronous timers for processing so the HTTP server remains independent and progress stays observable. Implement the browser page in the existing HTML file with inline JavaScript and polling. Preserve all commands and fixed files.

## Files
- `src/db.ts`: Extend database initialization with schema creation, prepared queries, transactions, job serialization, and heartbeat helpers.
- `src/jobs.ts`: Add shared job types, submission validation, and payload normalization.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, durable progress, retries, recovery, heartbeat updates, and shutdown.
- `ui/index.html`: Build the submission form and live job list with all required test selectors.

## Steps
1. **Define the shared model and schema.**
   - Preserve `openDatabase()`’s directory creation and `busy_timeout` before WAL configuration. Both processes initialize the same schema using `CREATE TABLE IF NOT EXISTS`; either can start first.
   - Store jobs with an integer insertion sequence as primary key, a unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, retry eligibility time in milliseconds, and nullable unique idempotency key.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first selection, including jobs created within the same millisecond.
   - Add a singleton worker-heartbeat table with a timestamp. Initialize no fresh heartbeat from the server.
   - Centralize serialization into the exact public job shape. Hide internal sequence, retry time, and idempotency fields; derive `progress.total` from steps and wrap completed output in `{ output }`.
   - Use bound SQL parameters and a transaction helper that always rolls back on failure. Never hold a transaction across `await`.

2. **Implement complete submission validation.**
   - Read the complete request body as UTF-8 before parsing. Treat empty or malformed JSON, `null`, arrays, and primitive bodies as `"body"` errors.
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` error.
   - Validate every own property against the three allowed fields, collecting all independently detectable errors rather than stopping at the first.
   - Require `input` to be a string whose JavaScript length is 1–1000 and whose trimmed value is nonempty. Store its original value.
   - Apply defaults only when fields are absent. Explicit `null`, numeric strings, fractional numbers, and out-of-range values fail validation.
   - Validate a present idempotency header against the exact required expression, including rejecting an empty value or duplicate values. Report `"Idempotency-Key"` on failure.
   - Return one consistent `invalid_request` envelope with a required `fields` array. Validation must finish before any database mutation.

3. **Implement HTTP routing and durable idempotency.**
   - Route by pathname, ignoring query parameters. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment.
   - Check allowed methods for recognized routes before handling them; return JSON `405 method_not_allowed`, preferably with `Allow`. Unknown paths and missing jobs return JSON `404 not_found`.
   - Serve the existing HTML path relative to `import.meta.url`; it already resolves correctly from `dist/server.js`. Only the page response uses HTML content type.
   - Implement list/detail endpoints through the shared serializer.
   - For creation, normalize to the fixed tuple `[input, steps, failAttempts]`. Inside `BEGIN IMMEDIATE`, look up the idempotency key, compare those immutable columns, and either replay the current job, report a conflict, or insert a new UUID job.
   - Keep the unique database constraint as the final safeguard against duplicate keys. Unkeyed submissions always insert.
   - Return the inserted queued snapshot with `201` without rereading after commit, because the worker could already have claimed it. Replay returns `200`; conflict returns `409`.
   - Read health from the stored heartbeat: worker is up only when its heartbeat is at most 3 seconds old.
   - Catch asynchronous handler failures and return a JSON error envelope for unexpected failures without leaking internals.

4. **Implement the worker’s normal processing loop.**
   - Write a heartbeat immediately and refresh it every 500 ms, including while idle, processing steps, and waiting for retries.
   - Poll for work approximately every 100 ms. Within a short transaction, select the oldest eligible queued job and claim it by setting `running`, incrementing attempts, resetting progress, clearing output/error, and updating its timestamp.
   - Process one job at a time. Sleep 100 ms before each step; commit progress after every successful step.
   - On the last successful step, atomically set completed progress, `completed` status, and JavaScript `input.toUpperCase()` output. Do not use SQLite’s uppercase function.
   - For attempt number `n <= failAttempts`, fail after the first 100 ms delay and before recording progress.
   - If fewer than three attempts have started, atomically return the job to `queued` with eligibility `now + 500 ms`, zero progress, and null result/error. Otherwise set `failed`, error `"transient failure"`, and null result.
   - Keep retry eligibility in SQLite so restarts cannot erase the delay. While a retry is ineligible, the worker may process another eligible job, choosing the oldest eligible job each time.
   - Update `updatedAt` on every job transition and progress write.

5. **Handle recovery and clean shutdown.**
   - Under the specified single-worker model, recover existing `running` work before claiming ordinary queued work. Server startup must never recover worker state.
   - Restart interrupted processing from step zero. Treat recovery as replay of the unfinished logical attempt, retaining its persisted attempt number; this avoids decrementing attempts or creating a fourth logical attempt when a worker dies during attempt three. Actual transient failures still advance through the normal retry path.
   - Persist the reset before processing; completed and failed rows are never selected.
   - Keep recovery immediate, satisfying the restart deadline without waiting for the old heartbeat to expire.
   - On worker `SIGTERM`/`SIGINT`, stop claiming work, allow the current bounded attempt to finish, clear the heartbeat timer and heartbeat row, then close SQLite. An attempt lasts at most about two seconds; do not wait through a future retry delay.
   - Abrupt termination leaves committed running state for recovery and a heartbeat that naturally expires.
   - On server shutdown, stop accepting connections, drain active responses with a bounded deadline, close remaining connections if necessary, and close SQLite after request handlers can no longer access it.
   - Retain references to all timers and server handles so shutdown leaves no live handles.

6. **Build the browser page.**
   - Add the specified form, input fields, submit button, alert region, list, and per-job selectors verbatim.
   - Initialize numeric fields to 5 and 0. Use `novalidate` so browser constraints do not hide API rejection messages. Convert nonempty numeric field values with `Number`; send an empty numeric field as an invalid value rather than silently defaulting it.
   - POST all three field values as JSON. Disable the button while a submission is pending and restore it in `finally`.
   - Clear `form-error` before a new submission and after success. On API rejection, show the error message plus every offending field’s name and message.
   - Fetch the list immediately on page load and after successful submission; poll every 500 ms using a serialized refresh loop to prevent stale responses overwriting newer results.
   - Render API order unchanged, with one `job-item` and `data-job-id` per job. Render exact status, `completed/total`, and either completed output, failure error, or empty text.
   - Use DOM creation and `textContent` for submitted input and results. Keep polling/network messages separate from the submission-error region.

7. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The supplied checks start their own processes and databases.
   - Supplement those examples with local HTTP and process-lifecycle checks using Node built-ins and temporary databases. Do not modify `checks/` or fixed configuration files.
   - Inspect the browser page manually for submission errors, live progress, terminal output, ordering, and safe text rendering.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both together against a missing parent directory; verify readiness within 10 seconds and custom port/database handling.
- **Validation:** Submit malformed JSON, arrays, null, missing content type, empty/whitespace input, overlong strings, numeric strings, fractions, null numeric values, unknown fields, and invalid keys. Confirm all applicable field names and no inserted jobs.
- **Defaults and exact input:** Omitted numeric fields become 5 and 0; surrounding whitespace remains stored; Unicode output matches JavaScript `toUpperCase()`.
- **Routing:** Check wrong methods on every known route, missing IDs, unknown paths, and JSON content types/error envelopes.
- **Idempotency:** Send concurrent requests sharing a key; verify one `201`, replays with the same ID, defaults-equivalent replay, and `409` for changed payloads. Repeat after server restart.
- **Processing and timing:** Poll a 20-step job frequently to observe running state and intermediate progress. Confirm idle pickup within one second and terminal progress equals steps.
- **Retries:** Exercise `failAttempts` 0 through 5; expect completion on attempts 1, 2, and 3 for values 0–2, and failure at attempt 3 otherwise. Observe queued retry delays and null errors before terminal failure.
- **Durability:** Kill the worker during progress and during a retry delay, then restart against the same database. Also stop both processes and restart them. Confirm recovery, retained IDs, terminal rows unchanged, and persistent idempotency.
- **Liveness and shutdown:** Verify worker-up while idle and busy, worker-down within three seconds after `SIGKILL`, and clean bounded `SIGTERM` exits.
- **UI:** Verify every required selector, newest-first ordering, numeric JSON submissions, field-specific alert text, and progress/status refresh within two seconds.

## Risks
- SQLite startup and concurrent writes can contend: preserve busy timeout, initialize idempotently, and keep transactions short.
- A worker can claim a newly inserted job before the server responds: return the creation snapshot to guarantee `201` contains a queued job.
- Restart semantics do not explicitly define whether interrupted work consumes another attempt: consistently replay the unfinished logical attempt, preserving the three-attempt retry budget.
- Startup recovery assumes one worker process, as specified; do not reset running rows from the server or from an ordinary polling iteration.
- Native form validation, overlapping polls, or unsafe HTML insertion can break browser requirements: use API validation, serialized refreshes, and text-only rendering.
- The supplied checks omit restart, UI, and many validation cases; passing them alone is insufficient.