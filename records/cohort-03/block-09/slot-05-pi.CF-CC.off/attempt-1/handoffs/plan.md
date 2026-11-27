# Plan

## Approach
Use Node.js built-ins and the existing TypeScript entry points, with SQLite as the sole communication channel between the server and worker. Centralize schema initialization and job serialization so either process can start first and every endpoint returns the same representation. Keep database transactions short; persist progress, retry eligibility, and worker heartbeats between asynchronous waits. Serve a dependency-free browser page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend database initialization with the shared schema, indexes, and transaction helper; preserve directory creation, busy timeout, and WAL configuration.
- `src/jobs.ts` (new): Define job types, map database rows to API objects, and implement submission, lookup, listing, and worker state transitions.
- `src/validation.ts` (new): Validate request headers and parsed bodies; apply defaults and collect field errors.
- `src/server.ts`: Implement routing, JSON responses, request parsing, idempotent submission, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, heartbeat updates, durable retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Implement the required form, error region, job list, and polling using inline JavaScript and CSS.
- Leave all fixed files and `checks/` unchanged. Preserve existing commands and the compiled entry-point layout.

## Steps
1. **Create the shared SQLite schema.**
   - Retain `DatabaseSync`, recursive parent-directory creation, and `busy_timeout` before enabling WAL.
   - Run idempotent schema creation from `openDatabase()` in both processes.
   - Create a `jobs` table containing:
     - An integer insertion sequence for deterministic ordering.
     - A unique public ID generated with `randomUUID()`.
     - Input, steps, fail-attempt count, status, attempts, completed-step count, nullable output/error, and ISO creation/update timestamps.
     - Nullable unique idempotency key and nullable retry eligibility time in epoch milliseconds.
   - Store the normalized payload directly in the immutable input/steps/fail-attempt columns; these suffice for idempotency comparison.
   - Create a singleton worker-heartbeat table storing the last observed epoch-millisecond timestamp.
   - Index queued-job selection. Use prepared statements and a transaction helper that always rolls back on failure.
   - Map rows explicitly to the required public shape, excluding internal columns. Derive `progress.total` from `steps`; expose result only for completed jobs and error only for failed jobs.

2. **Implement validation before any submission writes.**
   - Require the media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`.
   - Read and parse the body, returning a `"body"` field error for malformed JSON, empty bodies, arrays, null, primitives, or invalid/missing content type.
   - Inspect own properties and report every unknown field.
   - Validate input as a string with JavaScript length 1–1000 and nonempty `trim()`, while preserving the original string.
   - Apply defaults only when fields are absent. Reject null, strings, fractions, and values outside the specified numeric ranges.
   - Validate a present `Idempotency-Key` against the exact supplied regex; report the header name in `fields`. Reject repeated header values rather than silently accepting one.
   - Aggregate all independently detectable errors, including header errors alongside body-field errors. Always include `fields` for `invalid_request`.

3. **Implement atomic creation and idempotent replay.**
   - After validation, start `BEGIN IMMEDIATE`.
   - If a key exists, read its original job and compare all three normalized payload values. Return that job with 200 for equality or `idempotency_conflict` with 409 otherwise.
   - Otherwise insert one queued job with attempts/progress zero, null result/error, and matching initial timestamps.
   - Read the new job inside the transaction, commit, then return that captured queued representation with 201. This prevents a fast worker from changing the creation response to running.
   - Enforce key uniqueness in SQLite as well as application logic. Requests without keys store SQL null and always create new jobs.

4. **Complete HTTP routing and lifecycle.**
   - Match pathname independently of method:
     - `/`: GET serves the existing HTML location.
     - `/health`: GET reports worker up only when its database heartbeat is at most 3 seconds old.
     - `/api/jobs`: GET lists jobs by insertion sequence descending; POST submits.
     - `/api/jobs/:id`: GET returns the job or `not_found`.
   - Return 405 with `method_not_allowed` for unsupported methods on these route shapes, including `/`; return 404 for unknown paths. An `Allow` header may accompany 405.
   - Centralize JSON success/error responses with `application/json`; HTML is the intentional exception.
   - Catch asynchronous request failures and avoid unhandled rejections or stack traces in API responses.
   - Preserve `PORT` and `DATABASE_PATH` defaults and the existing UI path relative to the compiled server.
   - On SIGTERM/SIGINT, stop accepting connections, finish or close outstanding requests within a bounded interval, then close SQLite. Ensure idle keep-alive connections do not prevent exit.

5. **Implement the worker state machine.**
   - Write a heartbeat immediately after startup and every 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms. Select the oldest eligible queued job, excluding future retry times.
   - Claim it in a short `BEGIN IMMEDIATE` transaction: set running, increment attempts, reset completed progress to zero, clear retry time/result/error, and update the timestamp.
   - Await 100 ms for each step without holding a transaction.
   - On the first step, if the persisted attempt number is at most `failAttempts`, fail before recording progress:
     - Attempts 1–2: persist queued status, progress zero, null result/error, and eligibility time `now + 500 ms`.
     - Attempt 3: persist failed status, progress zero, null result, and error exactly `"transient failure"`.
   - Otherwise persist progress after every step. For the final step, atomically store full progress, completed status, and `input.toUpperCase()`.
   - Process only one job at a time. During a retry delay, other eligible jobs may run; selection remains oldest-first among eligible jobs.
   - Update `updatedAt` on every job transition and progress write.

6. **Handle restarts and shutdown deliberately.**
   - On worker startup, recover a persisted running job before ordinary queued work.
   - Treat recovery as continuation of the interrupted durable attempt: reset progress to zero and execute that attempt again using its existing attempt number. Do not allocate a fourth attempt when the interrupted job was already on attempt 3.
   - Persist recovery’s reset and timestamp before processing. Apply the same transient-failure rule to the retained attempt number.
   - Preserve future retry eligibility across restarts. Never select completed or failed jobs.
   - On SIGTERM/SIGINT, stop claiming work and interrupt or finish the current short sleep. Leave unfinished processing durably running for startup recovery; do not lose its attempt count.
   - Clear heartbeat state after processing has stopped, clear timers, and close SQLite. After SIGKILL, the heartbeat naturally expires.
   - This design assumes the task’s single worker process; do not add a second worker that independently resets another live worker’s running job.

7. **Build the browser UI.**
   - Include every specified `data-testid`, with `form-error` carrying `role="alert"`.
   - Use defaults 5 and 0 for numeric controls. Submit input unchanged and convert nonblank numeric field values with `Number()`; send blank numeric fields as invalid values rather than silently applying client-side defaults.
   - Use `novalidate` so browser constraints do not prevent API validation errors from reaching the required error region.
   - On submit, clear the old error, prevent duplicate in-flight submissions, and POST JSON. Show the API rejection message plus every field name/message; clear the region after success.
   - Fetch the list initially, immediately after successful submission, and approximately every 500 ms. Serialize list refreshes to prevent older responses overwriting newer data.
   - Render one `job-item` per job in API order with `data-job-id`, status, exact `completed/total` progress, and output/error as specified.
   - Use DOM creation and `textContent` for submitted input and outputs. Keep polling failures separate from the form’s API rejection region and recover on subsequent polls.

8. **Build and verify the complete contract.**
   - During implementation, run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Use additional local API/browser checks for requirements omitted by the supplied suites; do not modify the fixed checks.
   - Use isolated temporary database paths and clean up processes after each lifecycle test.

## Behaviours to verify
- **Startup and configuration:** Start server-first, worker-first, and simultaneously with a nested database path. Confirm startup within 10 seconds and correct custom/default ports.
- **Validation:** Test missing/blank/oversized input, Unicode length boundaries, nulls, numeric strings, fractions, out-of-range values, unknown fields, malformed JSON, nonobjects, bad content types, and invalid keys. Combine several errors and confirm every offending field appears and the job count stays unchanged.
- **Job representation and routes:** Check every returned job’s shape, nullability, timestamps, newest-first ordering, missing-job 404, unknown-route 404, and known-route 405.
- **Idempotency:** Compare omitted defaults against explicit defaults; send simultaneous matching and conflicting submissions; restart the server and replay. Confirm exactly one original job per key and distinct jobs without keys.
- **Processing and progress:** Submit a 20-step job and poll rapidly. Observe running status and intermediate progress, approximately 100 ms steps, pickup within 1 second when idle, and exact JavaScript uppercase output.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify completion attempts 1/2/3 or terminal failure at 3, zero progress on simulated failures, queued retry delay between 250 ms and 2 seconds, and one job throughout.
- **Durability:** Kill the worker during ordinary processing, retry waiting, and the third attempt. Restart with the same database and verify recovery within the specified window. Restart both processes and confirm terminal jobs and idempotency records remain unchanged.
- **Heartbeat and shutdown:** Confirm worker up while processing/retrying, down within 3 seconds after SIGKILL, and clean SIGTERM exits without lingering timers or open database handles.
- **Browser:** Submit valid and invalid values, verify field names in the alert, inspect every required test ID, and observe progress/results within 2 seconds without reload. Test HTML-looking input to confirm safe text rendering.

## Risks
- **SQLite contention:** Keep transactions synchronous and brief; never hold locks across sleeps or request-body reads. Preserve the starter’s busy-timeout-before-WAL ordering.
- **Creation-response race:** Return the captured inserted row, not a fresh query after commit.
- **Recovery attempt ambiguity:** The task requires interrupted work to run again but does not explicitly say whether recovery consumes another attempt. Preserve the interrupted attempt as a continuation, especially at attempt 3, while counting every normal queued-to-running attempt.
- **Incorrect defaulting or coercion:** Apply defaults only to absent properties and validate API numbers without coercion.
- **Unstable ordering:** Use the insertion sequence 
[truncated]