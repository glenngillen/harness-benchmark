# Plan

## Approach
Use the existing Node.js entry points and `DatabaseSync` helper, with SQLite as the sole communication channel between server and worker. Persist jobs, retry deadlines, idempotency keys, and worker heartbeats; keep transactions short and never hold one across a timer or HTTP body read. The worker processes one job at a time using asynchronous delays, while the browser polls the API. Preserve all existing commands and fixed files, and use only Node.js built-ins.

## Files
- `src/db.ts`: Extend database initialization with schema creation, prepared queries, transactions, job serialization, and durable state transitions.
- `src/jobs.ts`: Add job types, submission validation, normalized payload comparison, and shared response types.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, retries, restart recovery, and graceful shutdown.
- `ui/index.html`: Implement the submission form, accessible error display, job list, and polling using inline JavaScript and CSS.

## Steps
1. **Define shared types and validation.**
   - Represent the public job shape exactly as specified, including explicit `null` values for absent `result` and `error`.
   - Validate parsed bodies as non-null, non-array objects. Inspect every own key against the allowlist and collect all offending fields.
   - Require `input` to be a string with JavaScript `.length` between 1 and 1000 and a nonempty `.trim()` result. Store the original string.
   - Apply defaults only when a property is absent; reject explicit `null`, numeric strings, booleans, fractions, and out-of-range values.
   - Normalize successful validation to `{ input, steps, failAttempts }` with a fixed property order.
   - Validate a present `Idempotency-Key` against the specified expression, including rejecting an empty value. Report its field name exactly as `Idempotency-Key`.

2. **Initialize SQLite safely from either process.**
   - Retain directory creation, `busy_timeout` before WAL activation, and the existing default database path.
   - Use `CREATE TABLE IF NOT EXISTS` so either process can initialize a fresh database.
   - Store jobs with an integer insertion sequence, unique public UUID, status, input, steps, failure configuration, attempts, completed steps, output, error, ISO timestamps, nullable unique idempotency key, and retry availability time in epoch milliseconds.
   - Use the insertion sequence for deterministic oldest/newest ordering, including jobs created within the same millisecond.
   - Store the worker heartbeat in a separate singleton table. Only the worker writes it.
   - Add an index supporting queued-job selection. Use parameterized statements and one serializer that exposes only the required public fields.
   - Wrap multi-statement mutations in `BEGIN IMMEDIATE` / `COMMIT`, with rollback on errors. Do not reset existing data during initialization.

3. **Implement HTTP routing and error handling.**
   - Preserve `PORT` and the existing HTML path resolved relative to `import.meta.url`; this works from compiled `dist/server.js` without copying UI files.
   - Recognize `/`, `/health`, `/api/jobs`, and exactly one ID segment after `/api/jobs/`.
   - Check known paths before dispatching methods: unsupported methods return JSON `405 method_not_allowed`, preferably with `Allow`; unknown paths return JSON `404 not_found`.
   - Serve `/` as HTML. Send all API successes and errors with `application/json; charset=utf-8`.
   - Implement list and detail reads using the common serializer; list jobs by insertion sequence descending.
   - For health, report `"up"` only when the persisted heartbeat is no more than 3000 ms old; otherwise report `"down"`. A server without a worker must remain usable.
   - Catch asynchronous handler failures so malformed requests cannot crash the server or produce an unhandled rejection. Return a structured JSON server error for unexpected failures without exposing internals.

4. **Implement submission and atomic idempotency.**
   - Read the complete request body asynchronously and decode UTF-8 after joining buffers.
   - Accept the `application/json` media type case-insensitively, with optional parameters such as `charset=utf-8`; reject missing or other media types with field `body`.
   - Return `400 invalid_request` with a required `fields` array for malformed JSON, invalid body shape, invalid fields, or invalid key. Aggregate independently detectable errors; avoid inventing missing-field errors when the body cannot be parsed.
   - Finish validation before opening the creation transaction.
   - Inside the transaction, look up a supplied key. Compare its job’s immutable input, steps, and failAttempts against the normalized submission.
   - Return the original job’s current state with `200` for an equal payload, or `409 idempotency_conflict` for a different payload.
   - Otherwise insert exactly one queued job using `randomUUID()`, attempts and progress zero, null result/error, and equal initial timestamps.
   - Capture the inserted job representation within the transaction and return it with `201`. This ensures the creation response remains queued even if the worker claims it immediately after commit.
   - Enforce uniqueness in SQLite as well as application logic. Submissions without a key use SQL `NULL` and always create a new job.

5. **Implement the worker’s durable processing loop.**
   - Write a heartbeat immediately on startup and approximately every 500 ms, including during processing and retry waits.
   - Poll for available queued jobs every 100 ms when idle. Select by insertion sequence ascending among jobs whose retry deadline has passed.
   - Claim a job atomically: set running, increment attempts, reset progress to zero, clear output/error, and update `updatedAt`.
   - Process sequentially with awaited 100 ms timers. Do not use blocking sleeps or run overlapping asynchronous interval callbacks.
   - At the first step, after its delay but before recording progress, simulate failure when the persisted attempt number is at most `failAttempts`.
   - For failed attempts 1 and 2, atomically return the same job to queued with zero progress, null output/error, and a persisted retry deadline 500 ms in the future.
   - On the third simulated failure, set failed with exactly `"transient failure"`, attempts 3, and null output.
   - For successful steps, persist progress and `updatedAt` after each delay. Commit the final progress increment and completed status/output together.
   - Calculate output with JavaScript `input.toUpperCase()`, not SQLite’s `UPPER`, which has different Unicode behavior.
   - While one job waits for its retry deadline, allow other eligible queued jobs to run.

6. **Handle restart recovery and shutdown explicitly.**
   - At worker startup, recover persisted running work before taking ordinary queued work. The specified deployment has one worker process.
   - Treat recovery as replay of the interrupted durable attempt: reset its progress to zero and rerun that attempt using its persisted attempt number. Do not increment again merely for replay. Normal claims from queued still increment attempts.
   - This preserves the three-attempt limit even if the worker dies during attempt 3. Apply the same simulated-failure rule to the recovered attempt, then either retry, fail, or complete normally.
   - Never select completed or failed jobs. Preserve queued retry deadlines across restarts.
   - Register worker signal handlers that stop new claims, interrupt or finish the current short sleep, and leave unfinished work durably running for recovery. Stop heartbeat timers, clear the heartbeat on graceful exit, and close SQLite only after worker callbacks have stopped.
   - On server `SIGTERM`, stop accepting requests, finish active responses, close idle connections, then close SQLite. Bound shutdown of stalled connections so the process exits promptly.
   - Avoid unconditional `process.exit()` before pending cleanup completes.

7. **Build the browser page.**
   - Include all required `data-testid` elements, with `form-error` carrying `role="alert"` and initially empty.
   - Use a textarea or text input for input and numeric fields initialized to 5 and 0.
   - Disable native form validation with `novalidate` so API rejection messages are observable. Send numeric controls as numbers; handle empty or invalid numeric entries explicitly so they do not accidentally become valid zero values.
   - Submit JSON without an automatically reused idempotency key. Disable the submit button only while submission is pending.
   - Clear the previous form error when starting a submission. On API rejection, display its message plus every offending field name and message; polling must not erase this error. Clear it after successful submission.
   - Fetch jobs immediately on page load, after successful submission, and approximately every 400–500 ms using a non-overlapping polling loop.
   - Render jobs in API order. Each item must carry `data-testid="job-item"` and `data-job-id`, with status, `completed/total`, and result/error descendants using the specified test IDs.
   - Use DOM creation and `textContent` for submitted input and output. Preserve multiline result formatting with CSS.
   - Handle fetch failures without stopping future polling or overwriting form-validation messages.

8. **Compile and validate the complete implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The existing checks are examples only: additionally exercise durability, the browser, validation boundaries, and retry exhaustion.
   - Keep any added verification source under `src/` if retained. Do not change fixed files, dependencies, or `checks/`.

## Behaviours to verify
- **Startup and process independence:** Start server alone, worker alone, and both concurrently against a fresh nested database path. Confirm startup within 10 seconds, server availability without the worker, and heartbeat changes from down to up.
- **Validation:** Submit malformed JSON, arrays, null, missing input, whitespace-only input, 1001-character input, numeric strings, null numeric fields, fractions, boundary violations, unknown fields, invalid keys, and missing/non-JSON content types. Check all offending names and unchanged job count.
- **Exact input semantics:** Submit padded input, multiline text, emoji, and text such as `straße`. Confirm input preservation, JavaScript string-length validation, and JavaScript uppercase output.
- **Routes and representation:** Check every endpoint, unknown paths, and wrong methods. Confirm JSON errors, exact public fields, explicit nulls, valid timestamps, and stable newest-first ordering.
- **Idempotency:** Replay omitted versus explicit defaults, replay after completion and server restart, conflict on each payload field, and issue concurrent requests with the same key. Confirm one durable job and the required status codes.
- **Processing timing:** Poll a 20-step job frequently. Observe running status and increasing progress, approximately 100 ms steps, and idle pickup within 1 second.
- **Retries:** Exercise `failAttempts` 0 through 5. Expect successful attempt counts 1, 2, and 3 for values 0, 1, and 2; values 3–5 must fail on attempt 3. Observe queued retry intervals and zero progress on failed attempts.
- **Durability:** Kill the actual worker process during processing, restart on the same database, and confirm recovery within the specified window. Repeat during attempt 3 and a queued retry delay. Restart both processes and confirm terminal jobs and idempotency mappings persist unchanged.
- **Shutdown and health:** Send `SIGTERM` while idle and busy; confirm prompt exits and successful restart. After `SIGKILL`, confirm health becomes down once the last heartbeat is older than three seconds.
- **B
[truncated]