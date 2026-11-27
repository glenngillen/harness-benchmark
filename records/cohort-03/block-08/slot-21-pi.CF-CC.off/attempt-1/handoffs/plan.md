# Plan

## Approach
Use the existing Node.js HTTP server and worker entry points, with SQLite as the sole communication and persistence layer. Centralize schema initialization, job serialization, and transactional state changes so either process can start first. The worker will poll for eligible jobs, persist progress after each timed step, and publish a heartbeat independently of processing. The browser page will submit through the API and poll for updates without dependencies.

## Files
- `src/db.ts`: Extend database initialization with durable schema, indexes, shared job types/serialization, and transactional persistence helpers.
- `src/validation.ts`: Add request validation and normalized submission types.
- `src/server.ts`: Implement API routing, JSON errors, idempotent submissions, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement FIFO processing, progress, delayed retries, restart recovery, heartbeat, and shutdown.
- `ui/index.html`: Implement the submission form, accessible error region, job list, and polling script.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Define the database schema and public representation.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL initialization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both entry points. Use durable SQLite synchronization, such as `PRAGMA synchronous = FULL`.
   - Store jobs with an internal integer sequence primary key, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO timestamps, retry eligibility time, and nullable unique idempotency key.
   - Generate public IDs with `randomUUID()` from `node:crypto`.
   - Use the insertion sequence for deterministic ordering, including jobs created in the same millisecond. Index queued-job selection.
   - Add a singleton worker heartbeat table containing the last heartbeat epoch time.
   - Provide one serializer that exposes exactly the specified job properties, constructs `progress`, and returns `result` only for completed jobs and `error` only for failed jobs. Keep scheduling and idempotency columns private.
   - Use prepared statements and short synchronous transactions with rollback on exceptions. Never hold a transaction across a timer or request-body read.

2. **Implement validation before any submission mutation.**
   - Read the complete request body and parse JSON inside controlled error handling; handle aborted/erroring request streams without crashing the server.
   - Require media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`.
   - Require a non-null, non-array object. Use `body` for malformed JSON, invalid body shape, and missing/incorrect content type.
   - Enumerate unknown own properties and validate all known fields, accumulating each offending field rather than stopping at the first.
   - Check `input` with JavaScript `.length`, requiring 1–1000 code units and nonempty `.trim()`, while storing its original value.
   - Apply defaults only to absent numeric fields. Reject null, booleans, numeric strings, fractions, and out-of-range values with `Number.isInteger` and explicit type checks.
   - Validate an explicitly supplied `Idempotency-Key` against the exact regex, including rejection of an empty value. Report its field name exactly as specified.
   - Every validation response includes `error.code`, a useful message, and `fields`; invalid submissions never reach insertion.

3. **Implement atomic submission and idempotency.**
   - Normalize successful validation to `{ input, steps, failAttempts }`.
   - Within `BEGIN IMMEDIATE`, look up the supplied key. Compare all three normalized values directly with the stored original submission.
   - Return the current original job with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert one queued job with attempts/progress zero, null output/error, and equal creation/update timestamps; commit before responding.
   - Return the inserted queued snapshot with `201`, rather than rereading after commit when the worker may already have claimed it.
   - Keep the database uniqueness constraint as the final protection against duplicate keyed submissions. Without a key, always insert.
   - Persist keys with jobs so replay and conflict behavior survive server restarts.

4. **Complete routing and server lifecycle.**
   - Match the URL pathname independently of query parameters.
   - Recognize `/`, `/health`, `/api/jobs`, and exactly one ID segment under `/api/jobs/`.
   - Dispatch allowed methods explicitly: GET for `/`, `/health`, and individual jobs; GET and POST for `/api/jobs`.
   - Return `405 method_not_allowed` for recognized routes with unsupported methods, optionally including `Allow`. Unknown paths and missing jobs return `404 not_found`.
   - Return all API successes and errors with `application/json`; serve `/` as HTML.
   - List jobs by descending insertion sequence; fetch individual jobs using bound parameters.
   - Read heartbeat state on each health request; report up only when its age is at most 3000 ms. A missing heartbeat means down.
   - Preserve the existing module-relative HTML path, which works from `dist/server.js` without copying UI files.
   - Catch unexpected request failures and return a structured JSON server error where possible.
   - On SIGTERM/SIGINT, stop accepting connections, finish or bound outstanding requests, then close SQLite. Avoid leaving keep-alive or partial-body connections hanging indefinitely.

5. **Implement the worker state machine.**
   - Initialize the database, recover interrupted running jobs, publish an immediate heartbeat, and start a heartbeat timer at roughly 500 ms.
   - Poll for work every 100 ms. Select the oldest queued job whose persisted retry eligibility time has arrived; waiting retries must not block other eligible jobs.
   - Claim inside a short write transaction: set running, increment attempts, reset completed steps, clear output/error, and update the timestamp. Process one claimed job at a time.
   - For each step, await roughly 100 ms with an asynchronous timer.
   - On the first step, if the attempt number is at most `failAttempts`, record no progress:
     - Before attempt 3, return the job to queued with eligibility approximately 500 ms later and null public error/result.
     - At the third failed attempt, mark failed with `"transient failure"`, null result, and attempts 3.
   - Otherwise persist each completed step. On the final step, atomically persist full progress, completed status, and the JavaScript `input.toUpperCase()` output.
   - Update `updatedAt` on every job transition/progress change; never change `createdAt`.
   - Keep the heartbeat running during step waits and retry waits. Do not block the event loop with processing sleeps.

6. **Handle interruption and restart explicitly.**
   - Under the specified single-worker deployment, recover leftover running rows at worker startup; the server must never perform worker recovery.
   - Preserve durable input, attempt count, and job identity. Reset progress when beginning replacement processing, and never touch completed or failed rows.
   - Persist retry deadlines so restarting does not discard scheduled retry delays.
   - For an interrupted attempt below the attempt limit, requeue it immediately; the next claim starts and counts a new attempt.
   - Handle an interrupted third attempt explicitly without starting attempt 4: replay that interrupted attempt from progress zero using its existing attempt number, applying the same simulated-failure rule. This allows crash recovery without exceeding the three-attempt budget; document this recovery interpretation in the worker code.
   - On SIGTERM, stop claiming new work, finish the current short step and exit without completing the rest of the job. Leave unfinished running state recoverable, clear the heartbeat, stop timers, and close the database.
   - SIGKILL requires no special handler: committed state survives, the heartbeat expires, and startup recovery handles running jobs.

7. **Build the browser page.**
   - Include every required `data-testid`, with one `job-item` carrying `data-job-id` per job inside `job-list`.
   - Provide input, steps, and fail-attempt fields; initialize numeric fields to 5 and 0.
   - Use `novalidate` so browser constraints do not prevent API validation errors from reaching the required alert region.
   - Submit raw input text and explicitly converted numeric values. Treat blank numeric values as invalid values rather than accidentally converting a blank fail-attempt field to valid zero.
   - Keep `form-error` present with `role="alert"` and empty initially. Clear it on a new submission; on rejection display the API message and every returned field name/message.
   - Fetch jobs on page load, immediately after successful submission, and approximately every 500 ms using a non-overlapping polling loop.
   - Render status, exact `completed/total` progress, and output/error according to status, preserving newest-first ordering.
   - Use DOM creation and `textContent` for user input, results, and errors to prevent HTML injection. Polling must not reset form fields or erase submission errors.
   - Handle fetch failures and resume polling automatically.

8. **Build and verify in the implementation session.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Resolve strict TypeScript and `node:sqlite` row-typing issues without changing compiler configuration.
   - Supplement the disclosed checks with temporary local HTTP/process probes and browser inspection; do not modify `checks/` or add dependencies.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate trials with the same fresh nested `DATABASE_PATH`; confirm startup within 10 seconds, configured port, and automatic directory creation.
- **Public representation:** Check initial, running, retrying, completed, and failed snapshots for every required property, ISO timestamps, nullability, and stable IDs.
- **Validation:** Submit malformed JSON, arrays/null/scalars, missing content type, whitespace-only input, oversized input, numeric strings, fractions, null fields, multiple invalid fields, unknown fields, and malformed keys. Confirm named errors and unchanged job count.
- **Defaults and Unicode:** Omit numeric fields and verify defaults; use whitespace-surrounded and non-ASCII input to verify exact storage and JavaScript uppercase behavior.
- **Idempotency:** Replay omitted versus explicit defaults, changed field ordering, and changed payloads. Send concurrent requests using one key and repeat after server restart; verify exactly one job. Unkeyed repeats must create separate jobs.
- **Routes:** Exercise missing IDs, unknown paths, query strings, and wrong methods on each known path; verify status codes and JSON content types.
- **Timing and progress:** Poll a 20-step job frequently and observe intermediate progress, monotonic counts within an attempt, timely pickup, and final full progress.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5; expect completion on attempts 1, 2, and 3, then terminal failure at 3 for the last two cases. Observe zero-progress queued retry intervals and no duplicate jobs.
- **Ordering:** Queue several jobs with the worker stopped; start it and verify oldest-first processing and newest-first API/UI listing.
- **Health:** Confirm up while idle and processing, down after graceful shutdown, and down within three seconds after the last heartbeat following SIGKILL.
- **Durability:** Stop/restart both processes against the same database using SIGTERM and SIGKILL. Verify queued jobs, retry delays, keys, and terminal jobs persist; kill during visible progress and confirm recov
[truncated]