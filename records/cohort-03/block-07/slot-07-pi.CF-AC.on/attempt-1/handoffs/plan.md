# Plan

## Approach
Use `node:sqlite` as the sole communication and persistence mechanism between the HTTP server and worker. Centralize schema initialization, job serialization, and transactional state changes so either process can start first. Keep the existing entry points and commands, and implement the browser page with inline JavaScript that polls the API. Use short database transactions, asynchronous processing delays, and persisted retry deadlines so progress remains observable and restarts preserve work.

## Files
- `src/db.ts`: Extend database initialization with shared schema, prepared queries, transactions, serialization, and persisted worker heartbeat.
- `src/jobs.ts`: Add job and request types, strict validation, normalized payload comparison, and API error helpers.
- `src/server.ts`: Replace the placeholder with routing, JSON request handling, job endpoints, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Replace the placeholder with sequential processing, heartbeat updates, retries, restart recovery, and shutdown handling.
- `ui/index.html`: Build the submission form and automatically refreshed job list with all required test IDs.
- Leave package files, TypeScript configuration, `.gitignore`, `TASK.md`, and `checks/` unchanged.

## Steps
1. **Implement the shared database schema.**
   - Preserve directory creation and the existing `busy_timeout`-before-WAL initialization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` in either process.
   - Store jobs with an integer insertion sequence, unique server-generated UUID, status, exact input, steps, fail-attempt limit, attempts, completed steps, output, error, creation/update timestamps, nullable unique idempotency key, and retry eligibility time.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first processing, including jobs created in the same millisecond.
   - Store heartbeat time separately from jobs. Use epoch milliseconds for scheduling and heartbeat comparisons, ISO strings for public timestamps.
   - Expose one serializer that returns exactly the required job shape, deriving `progress.total` from `steps` and returning explicit `null` values for absent result/error.
   - Use parameterized SQL. Roll back transactions on exceptions; never hold a transaction across an asynchronous wait.

2. **Implement strict submission validation.**
   - Accept `application/json` case-insensitively, allowing parameters such as `charset=utf-8`; reject missing or other media types with a `body` field error.
   - Read the complete body asynchronously and catch malformed JSON, stream failures, and non-object values, including arrays and `null`.
   - Inspect own properties and list every unknown or invalid field. Use property presence to apply defaults only when fields are absent; do not silently default `null`.
   - Validate input using JavaScript string length and `trim()` only to detect whitespace-only input. Preserve the original input.
   - Require actual integer numbers in the specified ranges, without coercion.
   - Validate an explicitly present `Idempotency-Key` against the exact regex, including rejecting empty and duplicate header values. Report it as `"Idempotency-Key"`.
   - Aggregate independently detectable errors, including header errors, into `invalid_request.fields`. Invalid submissions must not reserve keys or insert jobs.

3. **Implement transactional creation and replay.**
   - After validation, normalize to `{ input, steps, failAttempts }` in a fixed order.
   - In a short `BEGIN IMMEDIATE` transaction, look up any supplied key. Compare the three normalized values directly.
   - Return the existing job with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert a queued job with attempts/progress zero and null result/error, using `crypto.randomUUID()`.
   - Capture the created job representation inside the transaction, commit, and return that snapshot with `201`. This ensures the creation response remains queued even if the worker immediately claims it.
   - Enforce key uniqueness in SQLite as well as application logic. Use SQL `NULL` for submissions without keys so they always create new jobs.

4. **Complete HTTP routing and process lifecycle.**
   - Dispatch by parsed pathname, then allowed method: `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`.
   - Serve `/` as HTML using the existing `new URL('../ui/index.html', import.meta.url)` path, which also works from `dist/server.js`.
   - Return JSON for API responses and errors, using the required envelope and meaningful messages. Return `405` for a wrong method on a recognized route, even when a job ID does not exist; return `404` for unknown routes or missing jobs on GET.
   - Implement list and detail reads through the shared serializer.
   - Report worker up only when a stored heartbeat is no more than 3 seconds old; no heartbeat means down.
   - Catch asynchronous handler failures to prevent unhandled rejections. Return a JSON internal error when a response is still possible.
   - On `SIGTERM` or `SIGINT`, stop accepting connections, finish active handlers, close the database, and exit. Bound draining so idle or incomplete requests cannot keep shutdown alive indefinitely.

5. **Implement worker scheduling, progress, and retries.**
   - Write an initial heartbeat and refresh it approximately every 500 ms, including during processing and retry waits.
   - Use one processing loop, polling approximately every 100 ms when idle. Select the oldest eligible queued job; delayed retries must not prevent other eligible work.
   - Claim a job transactionally: set running, increment attempts, reset progress to zero, clear result/error, and update its timestamp.
   - Wait approximately 100 ms for each step using asynchronous timers. On the first step, fail before updating progress if `attempts <= failAttempts`.
   - For a transient failure before attempt 3, persist queued status and a retry deadline 500 ms in the future. Keep error/result null and progress zero.
   - On the third transient failure, atomically set failed with error exactly `"transient failure"` and null result.
   - After every successful step, persist completed progress and updated time. On the final step, atomically persist full progress, completed status, and the JavaScript `input.toUpperCase()` output.
   - Keep heartbeat writes separate from job timestamps. Do not use HTTP, IPC, or shared in-memory state to coordinate processes.

6. **Handle interrupted work and shutdown explicitly.**
   - Under the task’s single-worker model, recover persisted running work immediately at worker startup, before claiming ordinary queued jobs.
   - Re-execute an interrupted attempt from progress zero using its persisted attempt number. Treat this as recovery of that attempt, rather than consuming another transient-failure attempt; ordinary queued-to-running attempts still increment the counter.
   - This recovery policy prevents a crash during a successful third attempt from either creating attempt 4 or incorrectly producing a transient failure. Persist the reset before executing steps.
   - Preserve retry deadlines across restarts and never select completed or failed jobs.
   - On termination, stop claiming jobs, let any current short database operation finish, stop timers, clear the heartbeat, and close SQLite. An interrupted job can remain running for startup recovery.
   - Ensure abrupt termination requires no cleanup to recover: all essential state must already be committed.

7. **Build the browser interface.**
   - Add labeled input, steps, and fail-attempt fields with defaults 5 and 0, plus every specified `data-testid`.
   - Use a form with `novalidate` so API validation can produce the required visible rejection. Preserve text input exactly and send numeric field values as numbers; handle blank or invalid numeric entries so they reach the API as invalid values rather than disappearing into defaults.
   - Keep `form-error` permanently present with `role="alert"`. Clear it before submission and on success; on rejection show the API message and every offending field’s name/message.
   - Fetch jobs immediately on load and poll every 500 ms using a single non-overlapping refresh loop. Refresh promptly after successful submission.
   - Render jobs in API order, setting `data-job-id` on each item and the specified status, progress, and result elements.
   - Use DOM creation and `textContent` for submitted input, output, errors, and IDs. Do not interpolate user content into HTML.
   - Keep polling failures separate from submission validation errors. Prevent stale overlapping responses from replacing a newer list.

8. **Build and validate without changing the fixed checks.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Supplement the supplied checks with temporary local scripts using Node built-ins and browser inspection. The existing contract suite explicitly omits restart durability, UI behavior, and many validation cases.

## Behaviours to verify
- **Startup and configuration:** Start each process first using a fresh nested `DATABASE_PATH`; confirm directory creation and readiness within 10 seconds. Check default configuration separately.
- **Response shape and ordering:** Submit multiple jobs while the worker is stopped; verify queued creation snapshots, exact nulls, ISO timestamps, defaults, unique IDs, and newest-first lists.
- **Validation:** Exercise malformed JSON, empty bodies, arrays, null, missing/wrong content type, whitespace-only and oversized input, numeric strings, fractions, range violations, unknown fields, invalid keys, and multiple simultaneous field errors. Verify no inserted jobs.
- **Idempotency:** Compare omitted versus explicit defaults; issue concurrent same-key requests; restart the server and replay. Verify one ID, matching replay status 200, conflicts 409, and separate jobs without keys.
- **Routing:** Exercise unknown paths, missing IDs, and wrong methods on every known route; confirm JSON errors and required status codes.
- **Observable processing:** Poll a 20-step job frequently; observe running status and intermediate committed progress. Verify idle pickup within 1 second and approximately 100 ms per step.
- **Retries:** Test failAttempts 0, 1, 2, 3, and 5. Verify expected attempt counts, zero progress during failed attempts, queued retry delays, exact terminal errors, and no duplicate jobs.
- **Heartbeat:** Verify up during idle and active work; terminate or kill the worker and verify down after at most 3 seconds from its last heartbeat.
- **Durability:** Restart both processes against the same database after graceful shutdown and `SIGKILL`. Kill the worker during processing, a retry delay, and a third attempt; verify recovery, stable IDs, retained terminal jobs, and no repeated terminal processing.
- **UI:** Submit valid and invalid jobs through the form, inspect all test IDs and field names in errors, observe updates within 2 seconds, and verify HTML-like input renders as literal text.
- **Shutdown:** Send `SIGTERM` while idle and busy; confirm prompt exits without database errors or lost committed state.

## Risks
- **Recovery semantics:** The task does not explicitly define whether crash recovery consumes another attempt. Implement and document the interrupted-attempt recovery policy above consistently; never decrement attempts or turn an interruption into a fabricated transient failure.
- **SQLite contention:** Both processes initialize and write the same file. Preserve busy timeout ordering, use short transactions, and avoid sleeping while holding locks.
- **Creation-response race:** Reading a newly inserted job after committing can expose running status in a `201` response. Capture the queued representation before committing.
- **Validation gaps:** Truthy defaults, numeric coercion, trimming stored input, and re
[truncated]