# Plan

## Approach
Extend the existing TypeScript entry points using only Node.js built-ins. Put schema initialization, job serialization, and transactional state changes in a shared SQLite module that both processes can initialize independently. The server handles validation, durable idempotency, and the browser page; the worker processes one job at a time using short database transactions and asynchronous timers. Persist retry scheduling and worker heartbeat information so restarts do not depend on in-memory state.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactions, job serialization, and heartbeat storage.
- `src/jobs.ts`: Add shared job/payload types and submission validation.
- `src/server.ts`: Implement HTTP routing, request parsing, validation, idempotency, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, observable progress, retry scheduling, restart recovery, heartbeat updates, and graceful shutdown.
- `ui/index.html`: Build the submission form and polling job list with the required selectors.
- Leave all fixed files, commands, and files under `checks/` unchanged.

## Steps
1. **Define shared types and initialize SQLite from either process.**
   - Preserve directory creation and the existing `busy_timeout` before enabling WAL.
   - Use `CREATE TABLE IF NOT EXISTS` and short transactions so simultaneous startup works.
   - Store jobs with an internal increasing sequence, unique public UUID, status, original input, steps, fail-attempt limit, attempts, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, normalized payload fingerprint, and numeric retry-availability time.
   - Use the sequence for stable insertion ordering when timestamps tie: descending for listing and ascending for worker selection.
   - Store heartbeat time in a separate singleton table.
   - Centralize conversion from database rows to the exact public shape. Never expose internal scheduling, sequence, or idempotency fields. Return `progress.total = steps`, and explicitly include nullable `result` and `error`.
   - Use prepared statements and a transaction helper that always rolls back on failure. Never hold a transaction across an `await`.

2. **Implement complete submission validation.**
   - Read request chunks as buffers, concatenate, decode as UTF-8, and parse JSON with controlled error handling.
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types with field `body`.
   - Require a non-null, non-array object. Report malformed JSON and non-object bodies under `body`.
   - Collect all discoverable offending fields rather than returning at the first field error. Inspect own property names so unusual unknown keys are also rejected.
   - Require `input` to be a string with JavaScript length 1–1000 and nonempty `trim()`, but store the original string unchanged.
   - Apply defaults only when `steps` or `failAttempts` is absent. Require actual integer numbers in their respective ranges; reject null, strings, booleans, and fractions.
   - Validate a present `Idempotency-Key` against the exact required pattern, including rejecting empty or duplicate header values. Report its field name exactly.
   - Produce `{error:{code:"invalid_request",message,fields}}` and perform no database mutation on validation failures.
   - Compute the payload fingerprint from a fixed-order serialization of the validated input, steps, and failAttempts after applying defaults.

3. **Implement atomic creation and idempotency.**
   - For a validated submission, begin an immediate transaction.
   - If the supplied key already exists, compare its stored normalized payload. Return the original job’s current state with `200` for a match or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert a UUID-backed job with `queued`, attempts/progress zero, null output/error, and identical creation/update timestamps.
   - Read the new job inside the insertion transaction, commit, and return that captured queued representation with `201`. This prevents a fast worker from changing the creation response to `running`.
   - Enforce uniqueness in SQLite as well as in application logic. A missing key is stored as SQL null and never deduplicates submissions.

4. **Finish HTTP routing and shutdown.**
   - Route by parsed pathname, ignoring query strings.
   - Implement `GET /health`, `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/:id`, and `GET /`.
   - Health reads the persisted heartbeat and reports `up` only when its age is at most 3 seconds.
   - Match a job-detail route as exactly one path segment; handle malformed URI encoding without crashing.
   - Distinguish route recognition from method handling: recognized paths with unsupported methods return `405 method_not_allowed`; unknown paths and missing jobs return `404 not_found`.
   - Centralize JSON responses and structured errors. Preserve HTML content type for the page; use JSON content type for API and routing errors.
   - Catch asynchronous request-handler failures so malformed requests cannot cause unhandled rejections. Return a structured internal error for unexpected failures.
   - Retain the existing module-relative HTML lookup, which works from `dist/server.js`.
   - On SIGTERM/SIGINT, stop accepting connections, drain active handlers, and close SQLite afterward. Bound shutdown for stalled connections and avoid closing the database while handlers can still use it.

5. **Implement the worker state machine.**
   - Initialize SQLite and write a heartbeat immediately. Refresh it every approximately 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms when idle. Select the oldest queued job whose persisted availability time has arrived.
   - Atomically claim it by setting `running`, incrementing attempts, resetting progress to zero, clearing output/error, and updating its timestamp. Commit before waiting or processing.
   - Wait approximately 100 ms for every step using asynchronous timers.
   - At the first step, if the durable attempt number is at most `failAttempts`, fail before recording any progress.
   - For failures on attempts 1 or 2, atomically return the same job to `queued`, leave progress zero and public error/result null, and set availability to now plus 500 ms.
   - On the third simulated failure, atomically set `failed`, error `"transient failure"`, and null result.
   - On successful steps, persist progress and updatedAt separately after each delay. On the final step, atomically write full progress, `completed`, and `input.toUpperCase()` as output.
   - Delayed retries need not block other eligible jobs; among eligible jobs preserve oldest-first ordering.
   - Stop claiming work when shutdown begins. Finish or interrupt the current short wait, preserve recoverable durable state, clear heartbeat/timers, and close SQLite. Handle unexpected worker failures by exiting without falsely marking jobs completed.

6. **Make recovery explicit and durable.**
   - Assume the requested single worker process; only worker startup performs recovery. Starting or restarting the server must never reset running jobs.
   - On worker restart, recover any persisted running job before claiming fresh work and restart its steps from zero.
   - Treat this as continuation of the already-recorded interrupted attempt, retaining its attempt number; subsequent simulated-failure retries start new numbered attempts. This avoids exceeding three logical attempts or falsely failing a successful third attempt merely because the process died.
   - Keep the job running during that recovery, reset progress and update its timestamp transactionally, then apply the same step/failure logic.
   - Persist retry deadlines so a restart neither bypasses an unexpired delay nor adds an unnecessary full delay.
   - Never mutate completed or failed jobs during recovery. Keep recovery immediate so it meets the restart deadline.
   - Ensure the last progress update and successful completion are one transaction, preventing a durable half-completed final state.

7. **Build the browser page.**
   - Add labeled controls and all exact `data-testid` attributes from the task. Initialize numeric controls to 5 and 0.
   - Use a textarea for input and number controls for steps/failAttempts. Put `novalidate` on the form so API validation, including whitespace and range failures, remains observable.
   - Prevent normal navigation on submit. Send input unchanged and convert nonempty numeric values to numbers. Send an invalid value such as null for empty numeric controls rather than silently converting an empty string to zero.
   - Keep `form-error` present with `role="alert"`. Clear it when starting a submission and after success; on rejection display the API message and every field name/message.
   - Fetch jobs immediately and poll approximately every 300–500 ms. Serialize refreshes or discard stale responses so earlier requests cannot overwrite newer job state.
   - Refresh immediately after successful submission. Render jobs in API order, one `job-item` per job with `data-job-id`, and nested status, progress, and result elements.
   - Render submitted input, output, and errors using `textContent`, never interpolated HTML. Keep pending result elements empty.
   - Handle polling/network errors without stopping future refreshes or misrepresenting them as submission validation errors.

8. **Build and verify the completed implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The disclosed checks cover only basic startup, submission, selected validation cases, completion, one retry, and idempotency. Perform the additional checks below against isolated temporary databases without modifying `checks/`.
   - Review the final diff to confirm that only `src/` and `ui/` source files changed.

## Behaviours to verify
- **Independent startup:** Start the worker before the server, reverse the order, and start both simultaneously with a missing database parent directory. Both should become ready within 10 seconds.
- **Complete validation:** Submit malformed JSON, arrays, null, missing/wrong Content-Type, whitespace input, length boundaries, unknown keys, numeric strings, fractions, out-of-range values, and invalid keys. Combine several invalid fields and verify all are named and job count is unchanged.
- **Exact representation:** Inspect creation, running, retry-queued, completed, and failed responses through both detail and list endpoints. Check null fields, timestamps, original input preservation, and nested progress/result shapes.
- **Durable idempotency:** Replay omitted versus explicit defaults, change each payload field, issue concurrent identical-key requests, and repeat after restarting the server. Verify one job per key and new jobs for unkeyed submissions.
- **Processing and ordering:** Queue several jobs while the worker is stopped, start it, and poll frequently. Verify oldest-first pickup, sequential work, observable intermediate progress, and approximately 100 ms steps.
- **Retries:** Test failAttempts 0, 1, 2, 3, and 5. Expected terminal attempts are 1, 2, 3, 3, and 3; the last two fail with the exact required error. Observe queued retry delays and zero progress on simulated failures.
- **Unicode output:** Submit Unicode and surrounding whitespace; compare output to JavaScript `toUpperCase()` and length validation to JavaScript string length.
- **Crash durability:** Kill the worker during processing and during a retry delay, restart using the same database, and verify recovery, preserved job identity, and timely termination. Repeat with both processes killed and with a crash during the successful third attempt.
- **Terminal durability:** Restart both processes after completion/failure and verify terminal jobs and attempt counts remain unchanged.
- **Health and shutdown:** Observe worker up while idle and busy, down within 3 seconds after SIGKILL, and clean SIGTERM exit without lingering timers or locked database connections.
- **Routing:** Exercise wrong methods on every known route, unknown paths, missing IDs, and query strings; verify status codes and JSON error shapes.
- **Browser:** Submit successful, retrying, failing, and invalid jobs. Verify required selectors, each offending field in the alert, newest-first order, safe text rendering, and progress/status updates within 2 seconds.

## Risks
- **Crash-attempt semantics:** The task does not explicitly say whether interrupted attempts consume another retry. Use the documented logical-attempt continuation above consistently; do not decrement attempts, allow a fourth retry, or manufacture a transient failure solely because of a crash.
- **SQLite contention:** Keep transactions synchronous and brief, initialize busy timeout before WAL, and never sleep while holding a write transaction.
- **Creation-response races:** Capture the inserted queued row before committing; reading it afterward can expose worker updates in a required `201 queued` response.
- **Incomplete validation:** Defaults must not replace explicitly invalid values, and validation must finish before idempotency lookup or insertion.
- **Misleading check coverage:** Passing the supplied suites does not establish browser correctness, recovery, health expiry, or complete validation; verify those separately.
