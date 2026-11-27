# Plan

## Approach
Keep the existing TypeScript entry points and commands, using Node.js built-ins only. Initialize the same SQLite schema from both processes, with short transactions for job creation, claims, progress, retries, and worker heartbeats. The server handles validation and HTTP responses; the worker executes one job at a time using asynchronous timers. Serve a self-contained browser page from `ui/index.html` that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend the existing database initialization with schema creation, transactions, prepared queries, and shared job serialization.
- `src/jobs.ts` (new): Define job/payload types, submission validation, normalization, and structured API errors.
- `src/server.ts`: Implement routing, request parsing, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, persisted retry scheduling, interrupted-work recovery, and shutdown.
- `ui/index.html`: Build the form, validation-error region, job list, and polling logic with inline CSS and JavaScript.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Establish the database model.**
   - Preserve parent-directory creation and the existing ordering of `PRAGMA busy_timeout = 5000` before enabling WAL.
   - Run idempotent schema initialization in both processes so either can start first.
   - Store jobs with an internal integer creation sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, and retry availability time in epoch milliseconds.
   - Store a nullable unique idempotency key on the job row. SQLite permits multiple `NULL` values, supporting independent submissions without keys. The immutable input/steps/failAttempts columns provide the normalized payload comparison.
   - Add a singleton worker-state row containing its last heartbeat timestamp. Only the worker updates it; server startup must not mark the worker alive.
   - Order lists by creation sequence descending and queued claims by sequence ascending. This avoids timestamp ties and preserves creation order across retries.
   - Provide one serializer that emits exactly the public job shape, including nested progress, explicit `null` values, and no internal fields.

2. **Implement complete validation before database mutation.**
   - Accept `application/json` case-insensitively, including parameters such as `; charset=utf-8`. Missing or other media types produce an invalid-request error naming `body`.
   - Read the body asynchronously and catch malformed JSON. Reject arrays, `null`, and scalar values with a `body` error.
   - Collect every discoverable offending field rather than returning after the first field error.
   - Enumerate own keys and reject every unknown field, including names such as `__proto__`.
   - Validate `input` by JavaScript `.length` and `.trim()`, preserving the original string for storage.
   - Default `steps` and `failAttempts` only when absent; explicit `null`, strings, booleans, fractions, and out-of-range numbers are invalid.
   - Validate a present `Idempotency-Key` against the exact required regular expression and report its canonical field name. Check presence separately from truthiness so an empty header is rejected.
   - Return `400` with `error.code = "invalid_request"`, a readable message, and the collected `fields` array. Header errors can be collected even when the body cannot be parsed.

3. **Implement atomic submission and HTTP routes.**
   - Use a short `BEGIN IMMEDIATE` transaction for keyed submission: look up the key, compare normalized payload values, and either return the existing job, report a conflict, or insert the new row. Roll back on exceptions.
   - Generate public IDs with `randomUUID()`. New rows start queued with attempts/progress zero, no result/error, and equal creation/update timestamps.
   - Capture the inserted job within the transaction for the `201` response. Do not reread after committing: the worker could already have changed its status.
   - Return the current original job for a matching replay with `200`, and `409 idempotency_conflict` for differing normalized payloads. Invalid requests must never consume a key.
   - Implement `GET /api/jobs`, `GET /api/jobs/:id`, and `GET /health`; report worker up only when its recorded heartbeat is within the preceding 3 seconds.
   - Match known path patterns before checking methods. Wrong methods on `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` return `405 method_not_allowed`; unknown paths and missing jobs return `404 not_found`.
   - Use a shared JSON response helper for all API successes and errors. Unexpected handler errors should become a structured `500` response without terminating the server or exposing internal details.
   - Preserve the existing module-relative HTML lookup, which resolves from `dist/server.js` to `ui/index.html`, and honor `PORT`.

4. **Implement the worker state machine.**
   - Write a heartbeat immediately on startup and approximately every 500 ms thereafter, including during processing and retry waits.
   - Poll for work every 100 ms while idle. In a short transaction, claim the oldest eligible queued job whose retry availability time has arrived.
   - Starting a new attempt atomically changes status to running, increments attempts, resets completed steps to zero, clears result/error, and updates `updatedAt`.
   - Await approximately 100 ms before each step. Never hold a SQLite transaction across a timer.
   - At the first step, if the attempt number is at most `failAttempts`, fail before recording any progress:
     - Below attempt 3, return the same job to queued with a persisted availability time 500 ms in the future, zero progress, and null result/error.
     - At attempt 3, mark it failed with error exactly `"transient failure"` and null result.
   - Otherwise persist each completed step and update the timestamp. Commit the last step and terminal completion together, setting output with JavaScript `input.toUpperCase()`.
   - Process only one job at a time. Delayed retries remain queued; other eligible jobs may run while they wait.

5. **Make restarts and shutdown explicit.**
   - At worker startup, recover any persisted running job before claiming ordinary queued work. Under the requested single-worker deployment, such work belongs to the previous worker.
   - Treat crash recovery as replaying the interrupted logical attempt: retain its persisted attempt number, reset its progress, and execute that attempt again from step one. Increment attempts only when starting a newly queued attempt. This prevents a crash during attempt 3 from creating attempt 4 or stranding the job.
   - Apply the same transient-failure condition when replaying an interrupted attempt. Preserve retry deadlines for jobs already queued, and never select completed or failed jobs.
   - Keep heartbeat updates independent of the processing loop, and clear the heartbeat on graceful worker shutdown.
   - On worker `SIGTERM`, stop claiming work, stop timers, and leave interrupted running state recoverable before closing SQLite. Check the stop flag after asynchronous waits so no writes occur after closure.
   - On server `SIGTERM`, stop accepting connections, finish active handlers, close idle connections, and close SQLite after outstanding database users finish. Bound shutdown if a client holds a connection open.
   - Handle `SIGINT` similarly. Do not clear tables, reset terminal state, or perform server-side recovery.

6. **Build the browser interface.**
   - Include every required `data-testid`, with a `job-form`, input textarea, numeric controls defaulting to 5 and 0, submit button, empty `form-error` with `role="alert"`, and `job-list`.
   - Use `novalidate` so browser constraints do not suppress API validation errors. Convert numeric field values to numbers without permissive `parseInt` coercion; send blanks as an invalid value such as `null`.
   - Submit JSON to `/api/jobs`. Clear the previous error when submitting; on rejection, show the API message and every offending field name. Keep the form usable afterward and prevent overlapping submissions.
   - Fetch jobs immediately and poll about every 500 ms using a single in-flight refresh. Refresh after successful submission without allowing older responses to overwrite newer data.
   - Render jobs newest first. Each item carries `data-job-id`, status text, progress formatted exactly as `completed/total`, and output/error only for terminal states.
   - Use DOM creation and `textContent` for submitted text and errors. Preserve output whitespace with CSS rather than interpreting strings as HTML.
   - Handle polling failures without erasing existing jobs or producing unhandled promise rejections.

7. **Build and validate the finished implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The existing checks cover basic startup, submission, selected validation, completion, one retry, and idempotency. Supplement them with the restart, timing, validation, and UI checks below.
   - Keep any additional verification source under `src/` if committed; do not modify fixed checks or dependency/configuration files.

## Behaviours to verify
- **Startup and configuration:** Start each process first against a fresh nested `DATABASE_PATH`; verify readiness within 10 seconds and custom `PORT` handling.
- **Validation:** Exercise malformed/empty JSON, non-object bodies, missing/wrong content types, unknown fields, multiple simultaneous errors, whitespace input, Unicode length boundaries, numeric strings, nulls, fractions, bounds, and invalid keys. Verify field names and unchanged job count.
- **Response shape and routing:** Inspect every job-returning endpoint for exact fields and nulls. Check missing IDs, unknown paths, and wrong methods independently.
- **Idempotency:** Compare omitted versus explicit defaults; change each payload field; issue concurrent same-key submissions; replay after server restart. Expect one durable job and the correct `201`/`200`/`409` outcomes.
- **Ordering:** Submit several jobs while the worker is stopped, including rapid submissions sharing timestamps. Verify newest-first listing and oldest-first processing.
- **Progress and timing:** Poll a 20-step job frequently enough to observe intermediate progress. Confirm pickup within 1 second, roughly 100 ms steps, and progress reset on a new attempt.
- **Retries:** Test `failAttempts` values 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3 respectively, then terminal failure at attempt 3 for values 3 and 5. Verify zero progress on simulated failures and persisted retry delays.
- **Health:** Verify down before worker startup, up while idle and busy, and down within approximately 3 seconds after `SIGKILL`.
- **Durability:** Kill the worker mid-progress, including during attempt 3 after two simulated failures; restart and verify recovery within the deadline. Restart both processes with queued, retrying, completed, and failed jobs and verify preserved state and IDs.
- **Graceful shutdown:** Send `SIGTERM` to each process and verify timely exit without database errors; restart and verify interrupted work recovers.
- **UI:** Use the specified selectors to submit valid and invalid forms, observe all offending field names, and watch progress/results update within 2 seconds. Confirm failed-job text and safe rendering of HTML-like input.

## Risks
- **SQLite contention:** Keep transactions synchronous and brief, preserve WAL/busy-timeout setup, and never await inside a transaction.
- **Idempotency races:** A lookup followed by an unprotected insert is insufficient; combine transactional lookup/insertion with a database uniqueness constraint.
- **Crash recovery accounting:** Keep replay of an interrupted logical attempt distinct from starting a retry. Otherwise recovery can exceed the attempt cap or prematurely fail a recoverable third attempt.
- **Incorrect public state:** Centralize serialization and transitions so queued/running jobs never expose stale results or errors.
- **UI validation bypass:** Native form validation and permissive numeric parsing can prevent the API from reporting the required errors.
- **Incomplete verification:** The supplied suites explicitly omit persistence and browser coverage; passing them alone does not establish completion.