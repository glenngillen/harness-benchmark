# Plan

## Approach
Extend the existing TypeScript server and worker using only Node.js built-ins, with SQLite as their sole communication channel. Put schema initialization, job serialization, and transactional state changes in shared modules so either process can start first. Persist retry deadlines and worker heartbeats alongside jobs, and make every progress update independently durable. Serve a dependency-free browser page that submits to the API and polls for updates.

## Files
- `src/db.ts`: Extend the existing database opener with idempotent schema initialization, transaction helpers, and SQLite configuration.
- `src/jobs.ts` (new): Define job types, serialize database rows, and implement submission, listing, claims, progress, retry, completion, and recovery operations.
- `src/validation.ts` (new): Validate request headers and JSON payloads; return normalized values or structured field errors.
- `src/server.ts`: Replace placeholder routes with the HTTP API, HTML serving, and graceful shutdown.
- `src/worker.ts`: Replace the idle loop with heartbeat, recovery, sequential processing, and persisted retry scheduling.
- `ui/index.html`: Add the required form, error region, job list, styling, and browser JavaScript.
- Leave all fixed files, dependencies, commands, and `checks/` unchanged.

## Steps
1. **Define the shared database schema.**
   - Preserve parent-directory creation and set `busy_timeout` before enabling WAL, as the starter already does. Explicitly use durable synchronization and short transactions.
   - Create tables and indexes with `IF NOT EXISTS`; initialize them from both entry points without clearing existing state.
   - Store jobs with an increasing integer sequence for deterministic insertion order, a unique public UUID, input, steps, fail-attempt count, status, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, and an internal numeric `available_at` retry deadline.
   - Store an optional idempotency key in a nullable unique column on the job. SQLite permits multiple null values, so unkeyed submissions remain independent.
   - Create a singleton worker heartbeat record containing the last heartbeat time in epoch milliseconds.
   - Use prepared statements and explicit row conversion. The public serializer must return precisely the documented job fields, derive `progress.total` from `steps`, and expose result/error only for their respective terminal states.

2. **Implement validation before any submission write.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with a `body` field error.
   - Read the request body asynchronously, decode UTF-8, and catch malformed JSON. Reject null, arrays, and primitives with a `body` error.
   - For an object, collect all applicable field errors, including every unknown own property.
   - Require a string `input` with JavaScript length 1–1000 and nonempty `trim()`, but retain the original string unchanged.
   - Apply numeric defaults only when the property is absent. Reject null, strings, booleans, fractions, and values outside the specified integer ranges.
   - Validate a present `Idempotency-Key` against the exact regex; name that field exactly in errors. Do not treat an empty header as absent or silently accept duplicate header values.
   - Return `400` with `error.code = "invalid_request"`, a useful message, and the complete `fields` array. Collect header errors alongside body-field errors whenever the body is parseable.

3. **Make job creation and idempotency atomic.**
   - After validation, execute lookup/comparison/insertion inside a short `BEGIN IMMEDIATE` transaction, rolling back on exceptions.
   - Compare an existing keyed job’s immutable `input`, `steps`, and `failAttempts` directly with the normalized payload.
   - Return the original job’s current representation with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise generate `randomUUID()`, insert a queued job with attempts/progress zero, null output/error, and matching initial timestamps.
   - Capture the new queued representation within the transaction and return that snapshot with `201`. Do not reread after committing: the worker might already have claimed it.
   - Use the database uniqueness constraint as the final protection against duplicate keyed jobs across concurrent requests and restarts.

4. **Implement explicit HTTP routing.**
   - Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` before dispatching by method. Unknown paths return `404 not_found`; unsupported methods on recognized paths return `405 method_not_allowed`, optionally with `Allow`.
   - Serve `/` as HTML using the starter’s `import.meta.url`-relative path, which also works from `dist/server.js`.
   - Return JSON with the required content type and structured errors for every API response.
   - List jobs by insertion sequence descending; retrieve individual jobs through the shared serializer.
   - `/health` returns `worker: "up"` only when a stored heartbeat is at most 3 seconds old; a missing/stale heartbeat means `"down"`.
   - Catch asynchronous request-handler failures so they cannot crash the process or produce an unhandled rejection. Keep unexpected failures distinct from validation errors.
   - Retain `PORT` and `DATABASE_PATH` defaults. Keep the server handle for shutdown.

5. **Implement the worker’s durable state machine.**
   - Write a heartbeat immediately after initialization, then approximately every 500 ms while idle, processing, and waiting for retries. Use asynchronous timers so step delays do not block heartbeats.
   - Poll for work every 100 ms. Atomically select the oldest eligible queued job (`available_at <= now`) and claim it in a short transaction.
   - Claiming starts a new attempt: set `running`, increment attempts, reset completed steps to zero, clear result/error, and update the timestamp.
   - Process only one job at a time. Sleep approximately 100 ms before each step, then persist progress in its own transaction.
   - At the first step, if the current attempt number is at most `failAttempts`, fail before increasing progress.
   - For failures on attempts 1–2, atomically return the same job to queued with zero progress, null result/error, and `available_at = now + 500 ms`. Other eligible jobs may run during this delay.
   - On a third transient failure, set failed, attempts 3, null result, and error exactly `"transient failure"`.
   - On the last successful step, atomically save full progress, completed status, and `input.toUpperCase()`. Intermediate successful steps only update progress and timestamp.
   - Never hold a SQLite transaction open across a timer or other `await`.

6. **Handle restart recovery and process shutdown explicitly.**
   - At worker startup, recover persisted running work before claiming fresh jobs. With the specified single worker process, these rows belong to its interrupted predecessor.
   - Re-execute an interrupted durable attempt from step zero while retaining its existing attempt number. Treat this as continuation of that attempt, not a transient-failure retry; subsequent transient failures still use the normal persisted retry transitions. This avoids inventing a fourth attempt or skipping a simulated failure after a crash.
   - Preserve queued retry deadlines across restarts. Never reset completed or failed rows, and never run recovery from server startup.
   - On worker `SIGTERM`/`SIGINT`, stop claiming jobs and stop processing at the next timer boundary. Leave interrupted work durable for recovery, stop heartbeat timers, remove the heartbeat, and close SQLite.
   - On server shutdown, stop accepting connections, allow active requests a bounded drain, close remaining sockets if necessary, then close SQLite. Ensure no timers keep either process alive.
   - Abrupt termination requires no cleanup: WAL, committed state, and heartbeat expiry provide recovery.

7. **Build the browser page around the required selectors.**
   - Add `job-form`, labeled `job-input`, `job-steps` defaulting to 5, `job-fail-attempts` defaulting to 0, and `job-submit`.
   - Add an initially empty `form-error` with `role="alert"`, and `job-list`.
   - Use `novalidate` so browser range/required validation does not prevent API rejection messages from being displayed. Convert numeric field values to numbers, while sending an invalid value such as null for blanks rather than accidentally converting a blank to zero.
   - Submit JSON to `/api/jobs`; clear prior form errors when submitting and after success. On rejection, display the API message and every returned field name/message using `textContent`.
   - Load jobs immediately and refresh approximately every 500 ms. Serialize refresh requests or discard stale responses so an older response cannot overwrite newer state. Refresh after successful submissions.
   - Render newest first, with one `job-item` carrying `data-job-id` per job. Include `job-status`, `job-progress` formatted exactly as `completed/total`, and `job-result` containing output, terminal error, or an empty string.
   - Use DOM APIs and `textContent` for submitted input and output; never interpolate them into HTML. Handle polling errors without terminating future refreshes or overwriting form-validation feedback.

8. **Build and verify the full contract.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with temporary local probes and browser inspection; the existing checks explicitly omit important validation, restart, and UI cases.
   - Keep any implementation changes under `src/` and `ui/`; do not change the fixed checks to accommodate the implementation.

## Behaviours to verify
- **Startup and configuration:** Start each process first on a fresh nested database path, then start both together. Confirm readiness within 10 seconds and correct custom port/database handling.
- **Response shape and routing:** Check every route, absent job IDs, unknown paths, and unsupported methods; inspect status, content type, error codes, and complete job serialization.
- **Validation:** Exercise malformed JSON, missing/wrong content type, arrays/null, unknown fields, multiple simultaneous field errors, numeric strings, missing input, whitespace, boundary lengths, integer bounds, and invalid/empty idempotency keys. Assert job count is unchanged.
- **Exact input handling:** Submit surrounding whitespace, Unicode, and HTML-like text; check preservation, JavaScript uppercase output, and safe browser rendering.
- **Idempotency:** Replay omitted versus explicit defaults, send conflicting normalized payloads, submit the same key concurrently, and repeat after server restart. Confirm one stable job ID; unkeyed repeats must create distinct jobs.
- **Ordering and progress:** Queue several jobs with the worker stopped. Start it, verify oldest eligible job is processed first, newest-first listing remains stable, attempts increment correctly, and intermediate progress is observable.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3 respectively, then terminal failure on attempt 3 for the last two cases. Observe queued retry delays and zero progress on simulated failures.
- **Heartbeat:** Observe worker up during idle and processing, then down after graceful exit or within the heartbeat expiry window after `SIGKILL`.
- **Durability:** Kill the actual Node worker while running, including during attempt 3; restart on the same database and verify recovery within the required bound. Repeat during retry delay and after stopping both processes. Confirm terminal jobs remain unchanged.
- **UI:** Verify all test IDs, numeric payloads, visible field-specific rejection messages, newest-first jobs, result/error display, and automatic updates within 2 seconds.
- **Shutdown:** Send `SIGTERM` during idle and active work; confirm prompt clean exit and successful restart without database corruption.

## Risks
- **SQLite contention:** Keep initialization idempotent, set busy timeout before WAL, and keep every transaction synchronous and short.
- **Crash/retry accounting:** Distinguish continuing an interrupted attempt from starting a retry. Do not decrement durable attempt counts, exceed three attempts, or terminally fail successful work merely because its worker restarted.
- **Submission races:** Return the inserted queued snapshot, and enforce idempotency transactionally with a unique constraint.
- **Ordering ties:** Use the insertion sequence rather than timestamps alone; several submissions can share a millisecond.
- **False confidence from checks:** Passing the provided suites does not establish UI, recovery, validation completeness, or timing compliance; verify those separately.
- **TypeScript/runtime mismatch:** Preserve the existing ESM import conventions and compile against the installed Node typings; add no dependency or configuration changes.