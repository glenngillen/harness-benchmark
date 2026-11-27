# Plan

## Approach
Extend the existing TypeScript entry points using only Node.js built-ins, preserving the current commands and file layout. SQLite will hold jobs, idempotency keys, retry deadlines, and worker heartbeat state; both processes will initialize the same schema independently. Use short synchronous transactions for state changes and asynchronous timers for processing, with no database transaction held during a delay. Serve a small browser interface from the existing HTML file and poll the API for updates.

## Files
- `src/db.ts`: Extend database initialization with shared schema, prepared queries, transactions, and job serialization.
- `src/jobs.ts`: Add shared job and payload types, request validation, and payload normalization.
- `src/server.ts`: Implement HTTP routing, submission and idempotency handling, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, persisted retries, heartbeat updates, interrupted-attempt recovery, and shutdown.
- `ui/index.html`: Implement the form, error region, job list, styling, and polling JavaScript.
- Leave all fixed files and `checks/` unchanged. No dependencies are needed.

## Steps
1. **Define the shared database model.**
   - Preserve parent-directory creation and the existing `busy_timeout` before enabling WAL.
   - Initialize tables and indexes with `IF NOT EXISTS`, so either process can start first, including simultaneous startup.
   - Store jobs with an integer insertion sequence, unique public UUID, status, input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, and numeric retry deadline.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first processing, including jobs created within the same millisecond.
   - Add a singleton worker heartbeat row with a numeric timestamp.
   - Centralize row conversion to the exact public shape. Keep database-only fields private; derive `progress.total` from `steps` and return explicit `null` values for unavailable result/error.
   - Use parameterized SQL and a transaction helper that rolls back on exceptions.

2. **Implement validation before any database mutation.**
   - Read the complete request body, decode UTF-8, and parse JSON. Reject malformed JSON, null, arrays, and primitives with a `"body"` field error.
   - Require the media type `application/json`, allowing ordinary parameters such as `charset=utf-8` and case-insensitive media-type matching. Missing or incorrect content type yields a `"body"` error.
   - Check every own property against the allowed field names; report each unknown field.
   - Validate `input` with JavaScript `.length`, preserving its original value. Use `.trim()` only to reject whitespace-only input.
   - Require actual integer numbers in the documented ranges. Apply defaults only when a property is absent, never for explicit null, empty strings, or other invalid values.
   - Validate any supplied idempotency key against the exact regular expression, including rejecting an empty key.
   - Accumulate independent field errors, including header errors, and return `400 invalid_request` with `fields`. Do not let invalid submissions become replays or conflicts.
   - Normalize successful validation to `{ input, steps, failAttempts }`.

3. **Implement HTTP routes and atomic submission.**
   - Match the pathname separately from the method. Known paths are `/`, `/health`, `/api/jobs`, and a single ID segment under `/api/jobs/`.
   - Return `405 method_not_allowed` for unsupported methods on known routes and `404 not_found` for unknown paths. A missing job on a supported detail request also returns `404`.
   - Use one JSON response helper for API successes and all errors; serve `/` as HTML using the existing module-relative `../ui/index.html` path.
   - For creation, generate the public ID with `randomUUID()` and set initial values to queued, attempts/progress zero, and result/error null.
   - Handle key lookup, payload comparison, and insertion inside `BEGIN IMMEDIATE`. The unique nullable key constraint provides a second safeguard against duplicate creation.
   - Compare normalized payload fields directly with the stored original fields. Matching keys return the original job’s current state with `200`; mismatches return `409`; absent keys always insert.
   - Capture the newly inserted job within the transaction and return that queued snapshot with `201`, even if the worker claims it immediately afterward.
   - Implement list/detail reads through the common serializer.
   - Report worker `"up"` only when its stored heartbeat is at most 3 seconds old.
   - Catch request-handler errors so malformed requests and unexpected failures do not terminate the server. Unexpected failures should receive a JSON `500` response when a response remains possible.

4. **Implement the worker’s durable state machine.**
   - Write a heartbeat immediately after initialization and approximately every 500 ms during both idle and active periods.
   - Poll for work every 100 ms. Select the oldest eligible queued job whose persisted retry deadline has passed.
   - Claim it in a short transaction: set running, increment attempts, reset progress, clear output/error and retry deadline, and update the timestamp.
   - Process only one job at a time. Await approximately 100 ms per step, then commit the completed-step count and updated timestamp.
   - On the first step, before recording progress, simulate failure when the current attempt number is at most `failAttempts`.
   - For attempts 1 and 2 that fail, atomically return the job to queued with progress zero, null result/error, and a persisted deadline 500 ms in the future. Other eligible jobs may run while this job waits.
   - On the third simulated failure, atomically set failed with error exactly `"transient failure"`, attempts 3, and null result.
   - For success, commit the final progress, completed status, and JavaScript `input.toUpperCase()` output together. Never select completed or failed rows for processing.

5. **Make restart and shutdown behavior explicit.**
   - At worker startup, recover any persisted running job before claiming queued work. Replay its interrupted attempt from step zero using its recorded attempt number; a crash is an interruption, not an additional simulated failure. This also allows an interrupted third attempt to finish without inventing a fourth retry.
   - Keep the recovered job running, reset its progress durably, and apply the same first-step failure rule. Do not reset its historical attempt count or touch terminal jobs.
   - This recovery assumes the task’s single worker process; do not add a distributed lease system unless supporting simultaneous workers becomes a requirement.
   - On worker `SIGTERM`/`SIGINT`, stop claiming jobs, stop heartbeat scheduling, and finish the currently executing attempt before closing SQLite. With at most 20 steps at 100 ms, this remains bounded. A retry transition remains persisted for the next launch.
   - Clear the heartbeat on graceful exit. After `SIGKILL`, let the old heartbeat expire naturally.
   - On server termination, stop accepting connections, allow active handlers to settle, close connections within a bounded grace period, then close SQLite. Prevent late handlers or timers from accessing a closed database.
   - Keep every state transition committed independently so abrupt termination cannot lose earlier progress, retry scheduling, or results.

6. **Build the browser page.**
   - Add the exact required test IDs: form, input, steps, fail-attempts, submit, alert region, list, and each per-job status/progress/result element.
   - Set numeric field defaults to 5 and 0. Submit input unchanged and numeric fields as numbers; handle blank numeric values explicitly so they do not silently become valid zero values.
   - Use `novalidate` so browser-native validation does not prevent the API’s rejection messages from reaching the required error region.
   - On submission, clear the previous form error, disable the button while pending, and send JSON to `/api/jobs`.
   - On API rejection, show the error message and every returned field name/message in `form-error`, which must have `role="alert"`. Keep the region empty after a successful submission.
   - Fetch jobs immediately on page load, after successful submission, and approximately every 500 ms. Prevent overlapping refreshes or stale responses from overwriting newer state.
   - Render newest first with one `job-item` carrying `data-job-id` per job. Show status, `completed/total`, and output/error exactly as specified.
   - Insert all user-derived strings with `textContent`, preserving output whitespace where useful. Recover from transient polling failures without stopping future refreshes.
   - Include accessible labels and a compact responsive layout; keep scripts and styles inline to avoid additional asset routes.

7. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The disclosed checks cover basic startup, creation, a few validation cases, completion, one retry, and idempotency. Perform the additional checks below against a separate temporary database.
   - Do not modify the provided checks or fixed configuration files.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate runs, then start both simultaneously against a nonexistent database directory. Confirm readiness within 10 seconds and the configured port/path.
- **Validation:** Submit malformed JSON, arrays/null, missing or incorrect content type, unknown properties, numeric strings, fractions, range violations, whitespace input, and invalid keys. Verify all applicable field names and no new rows.
- **Exact string handling:** Submit leading/trailing whitespace, Unicode, and boundary-length strings. Confirm input is preserved and output matches JavaScript uppercase behavior.
- **Idempotency:** Compare omitted defaults with explicit defaults, vary each payload field, send concurrent requests with one key, and replay after server restart. Confirm one job per key and new jobs for requests without keys.
- **Routes and representation:** Check all documented status codes, wrong methods, unknown paths, missing IDs, JSON content types, explicit nulls, timestamps, and deterministic list order.
- **Processing timing:** Poll a 20-step job frequently enough to observe running progress. Confirm pickup within 1 second, approximately 100 ms steps, progress reset on attempts, and sequential processing.
- **Retries:** Test `failAttempts` from 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0, 1, and 2; failure on attempt 3 for values 3–5. Observe queued retry waits and no duplicates.
- **Restart durability:** Kill the worker while running, including during a successful third attempt; restart against the same file and verify recovery within the deadline. Restart during a retry delay and after terminal completion. Restart both processes and verify jobs and keys remain intact.
- **Heartbeat and shutdown:** Confirm health changes to up after worker start, down after graceful stop, and down within 3 seconds of abrupt death. Confirm both processes exit promptly on `SIGTERM`.
- **Browser behavior:** Submit valid and invalid forms, inspect every required test ID, verify field names in rejection messages, and observe progress/results without reload within 2 seconds. Reload the page and confirm persisted jobs remain visible.

## Risks
- Holding a transaction during a step or retry delay blocks the other process. Commit before every asynchronous wait.
- An in-memory retry timer or idempotency map breaks restart guarantees. Store deadlines and keys in SQLite.
- Startup races can fail schema creation or WAL initialization. Preserve the busy timeout ordering and use idempotent schema setup.
- Recovery must distinguish an interrupted attempt from a new retry. Replay the recorded attempt without exceeding the three-attempt retry budget or decrementing historical counts.
- Sorting only by timestamps makes same-millisecond ordering unstable. Use the insertion sequence.
- Form coercion, native validation, unsafe HTML insertion, or stale polling responses can violate otherwise-correct API behavior. Handle these explicitly in the browser code.