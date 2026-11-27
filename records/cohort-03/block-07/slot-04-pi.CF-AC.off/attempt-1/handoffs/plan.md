# Plan

## Approach
Use the existing TypeScript entry points with Node.js built-ins and SQLite as the only communication channel between server and worker. Put schema initialization and durable job operations in shared modules so either process can start first. Keep database transactions short, persist retry eligibility, and use asynchronous timers for processing and heartbeats. Serve a dependency-free browser page that submits jobs and polls their state.

## Files
- `src/db.ts`: Extend the existing database opener with idempotent schema initialization, prepared statements, transactions, and durable job operations.
- `src/jobs.ts`: Add shared job/payload types, validation, and explicit database-row-to-API serialization.
- `src/server.ts`: Implement routes, request parsing, validation, idempotent creation, health reporting, and shutdown.
- `src/worker.ts`: Implement sequential claiming, progress updates, retries, heartbeat, interrupted-job recovery, and shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, submission handling, and polling.
- Leave all fixed files, package scripts, and `checks/` unchanged.

## Steps
1. **Define the shared representation and SQLite schema.**
   - Retain directory creation, `DatabaseSync`, and the existing ordering of `busy_timeout` before WAL configuration. Use durable SQLite commits; do not disable synchronization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both entry points.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric `available_at` timestamp.
   - Use the insertion sequence for deterministic creation order, including jobs created in the same millisecond. List descending; claim ascending.
   - Add a singleton worker-state row containing its last heartbeat timestamp.
   - Define one serializer that emits exactly the specified public job shape, constructs `progress.total` from `steps`, and excludes internal database fields.
   - Update `updatedAt` on every job transition and progress write; preserve `createdAt`.

2. **Implement validation before any submission mutation.**
   - Read the request body asynchronously and handle malformed JSON and request-stream errors without an unhandled rejection.
   - Accept `application/json` case-insensitively, including ordinary parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` validation error.
   - Require a non-null, non-array JSON object. Use own-property checks to distinguish omitted fields from explicit `null`.
   - Collect all applicable errors: unknown property names, missing/invalid input, invalid steps, invalid failAttempts, and invalid `Idempotency-Key`.
   - Validate input using JavaScript `.length` and `.trim()` for the whitespace test, but store the original string.
   - Accept numeric fields only when their type is number, they are integers, and they fall within the specified bounds. Apply defaults only to absent properties.
   - Validate a present key against the exact regex; reject empty or ambiguous duplicate header values.
   - Always include `fields` for `invalid_request`, using `"body"` for parsing, media type, and whole-body errors. Return validation failures before checking idempotency.

3. **Implement atomic creation and idempotency.**
   - Use a synchronous `BEGIN IMMEDIATE` transaction with rollback on exceptions; never await inside a transaction.
   - For a supplied key, look up its existing job and compare the three normalized payload values directly.
   - Return that job’s current representation with `200` when equal, or `409 idempotency_conflict` when different.
   - Otherwise insert one queued job using `randomUUID()`, attempts/progress zero, null result/error, and immediate eligibility. Persist its key in the same row.
   - Enforce uniqueness in SQLite, not only in application code.
   - Capture the newly inserted queued representation before committing and return it with `201`; a fast worker must not change the creation response into a running job.
   - Submissions without keys always insert a new row.

4. **Complete HTTP routing and lifecycle.**
   - Resolve the pathname independently of query parameters.
   - Implement `GET /health`, `POST /api/jobs`, `GET /api/jobs`, and `GET /api/jobs/:id`.
   - Health reports `"up"` only when a worker-written heartbeat is at most 3 seconds old; the server never refreshes it.
   - Preserve `GET /` serving `ui/index.html` through the existing module-relative path, which also works from `dist/server.js`.
   - Determine whether a route is known before checking its allowed methods. Known paths with unsupported methods return JSON `405 method_not_allowed`; unknown paths return JSON `404 not_found`. A missing job returns `404 not_found`.
   - Use a common JSON response/error helper. Catch unexpected handler failures and return a structured `500` if a response is still possible.
   - Retain `PORT` default `3000` and `DATABASE_PATH` default `data/jobs.db`.
   - On `SIGTERM`/`SIGINT`, stop accepting connections, allow active handlers a bounded drain period, close remaining connections if needed, and close SQLite after handlers finish.

5. **Implement the worker’s durable state machine.**
   - Write an immediate startup heartbeat, then update it approximately every 500 ms, including while idle and during retries.
   - Poll eligible queued jobs every 100 ms when idle. Claim the oldest eligible row in a short transaction, setting `running`, incrementing attempts, resetting progress, and clearing output/error.
   - Process exactly one job at a time. Never hold a transaction or database lock during a timer.
   - Wait approximately 100 ms for each step. On the first step, if the current attempt number is at most `failAttempts`, fail before recording progress.
   - For a failed attempt below attempt 3, atomically set `queued`, progress zero, result/error null, and `available_at = now + 500 ms`. Persisting this deadline preserves the delay across restarts.
   - On the third simulated failure, atomically set `failed`, error `"transient failure"`, null result, and zero progress.
   - For successful steps, persist each completed-step count. Commit the final progress, completed status, and JavaScript `input.toUpperCase()` result together.
   - Skip queued jobs whose retry deadline has not arrived so other eligible jobs can run.
   - Guard updates by job ID, expected status, and attempt number to prevent accidental stale writes.

6. **Handle worker interruption and restart explicitly.**
   - Under the task’s single-worker model, recover durable `running` rows once at worker startup; server startup must never alter job states.
   - An interrupted attempt remains counted. If attempts are below 3, reset its progress and return it to queued for immediate eligibility; claiming it starts the next attempt.
   - Preserve the three-attempt ceiling: if an interrupted job already has 3 attempts, terminate it as failed instead of starting attempt 4. Use `"transient failure"` when its third attempt satisfies the simulated-failure condition; otherwise use a descriptive interruption error.
   - Leave existing queued retry deadlines and all terminal jobs untouched.
   - On graceful shutdown, stop claiming jobs, interrupt sleeps promptly, and leave any active job durably running for the same startup recovery path. Clear the heartbeat, stop timers, and close SQLite.
   - On `SIGKILL`, the last committed progress survives and the heartbeat naturally expires within 3 seconds.

7. **Build the browser page.**
   - Include every required `data-testid` exactly, with `form-error` carrying `role="alert"`.
   - Give numeric fields initial values `5` and `0`. Submit numeric values as JSON numbers; avoid converting an empty numeric field silently to zero—send an invalid value such as `null` so API validation rejects it.
   - Use `novalidate` on the form so API rejection messages can reach the required error region.
   - Clear the error region for each new submission; on rejection display the API message and every offending field’s name and message. Keep polling independent of form errors.
   - Fetch the list immediately on page load, after a successful submission, and approximately every 500 ms. Serialize list refreshes to avoid stale responses overwriting newer state.
   - Render one `job-item` with `data-job-id` per returned job, preserving the API’s newest-first order.
   - Render status, exact `completed/total` progress, and terminal result/error in the required descendants. Leave `job-result` empty for queued/running jobs.
   - Use DOM creation and `textContent` for submitted input, output, and errors; never interpolate user text into HTML.
   - Catch fetch failures and keep future polling active. Prevent duplicate in-flight form submissions without clearing the user’s values on rejection.

8. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the fixed checks with local HTTP, restart, and browser exercises below; the existing checks explicitly omit important durability and UI behavior.
   - Use temporary database paths and free ports. For crash tests, signal the actual Node process or its process group rather than only an npm wrapper.
   - Confirm the final source changes are limited to `src/` and `ui/`.

## Behaviours to verify
- **Startup and health:** Start each process first in separate runs against a missing database directory. Check readiness within 10 seconds, worker-up reporting, and worker-down within 3 seconds after killing the worker.
- **Response contracts:** Check initial queued defaults, exact job fields, null result/error, ISO timestamps, newest-first ordering, missing IDs, unknown routes, and wrong methods on every known route.
- **Validation:** Exercise malformed JSON, absent/wrong content type, primitives, arrays, null, whitespace input, lengths 1/1000/1001, Unicode JavaScript lengths, numeric strings, fractions, out-of-range values, explicit nulls, unknown fields, and multiple simultaneous errors. Confirm invalid requests create no rows.
- **Idempotency:** Replay omitted versus explicit defaults, change each normalized field, restart the server, and issue concurrent identical requests. Verify one ID and one row; requests without keys create distinct jobs.
- **Observable processing:** Submit a 20-step job and poll frequently. Confirm running status, incremental progress, roughly 100 ms steps, exact Unicode-aware JavaScript uppercase output, and one-at-a-time oldest-eligible processing.
- **Retries:** Exercise failAttempts 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3, then failure at attempt 3 for the remaining cases. Observe queued retry delays, zero failed-attempt progress, and no duplicate jobs.
- **Durability:** Stop/restart both processes with the same database. Kill a worker mid-job and during a retry delay. Verify terminal jobs stay unchanged, interrupted work recovers within the stated window, and idempotency persists.
- **Shutdown:** Send `SIGTERM` while idle and processing; verify both processes exit cleanly and restart without database corruption.
- **Browser:** Submit valid and invalid forms, verify numeric JSON types and all selectors, watch progress/status update within 2 seconds, inspect failed results, reload for durable history, and submit HTML-looking text to confirm safe rendering.

## Risks
- **Retry and crash accounting:** Do not decrement attempts, replay terminal jobs, or start a fourth attempt. The task does not specify the error for an interrupted third non-transient attempt; use the explicit terminal-interruption policy above.
- **SQLite contention:** Preserve busy-timeout-before-WAL ordering, initialize from either process, a
[truncated]