# Plan

## Approach
Use the existing Node HTTP server, a separate polling worker, and SQLite as the only communication and persistence mechanism. Centralize schema initialization, transactions, and job serialization so either process can start first. Persist retry deadlines and worker heartbeats, and commit each processing step separately so progress remains observable. Build the browser UI in the existing HTML file with inline JavaScript and periodic API polling; preserve all existing commands and fixed files.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactional submission and claiming, heartbeat storage, and job-state updates.
- `src/jobs.ts`: Add shared job/payload types, request validation, and the exact public job serializer.
- `src/server.ts`: Implement routing, JSON request handling, validation, idempotency, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, progress updates, retries, interrupted-job recovery, heartbeats, and graceful shutdown.
- `ui/index.html`: Implement the submission form, error region, job list, polling, and basic styling.
- Do not change configuration, dependency manifests, `TASK.md`, or `checks/`.

## Steps
1. **Define durable storage and public serialization.**
   - Preserve parent-directory creation and the existing `busy_timeout` before WAL configuration. Use `CREATE TABLE/INDEX IF NOT EXISTS` so simultaneous startup and either startup order work.
   - Store jobs with an insertion sequence (`INTEGER PRIMARY KEY`), unique public UUID, input, steps, fail-attempt setting, status, attempt count, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and retry eligibility time in epoch milliseconds.
   - Use the insertion sequence for deterministic oldest/newest ordering, including submissions created in the same millisecond.
   - Store worker heartbeat time in a separate singleton table. Schema initialization must not reset an existing heartbeat or job.
   - Serialize only the documented properties. Derive `progress.total` from `steps`; expose `result: {output}` only for completed jobs and `error` only for failed jobs. Keep database bookkeeping private.
   - Use bound parameters and short transactions with rollback on exceptions. Never keep a transaction open across an asynchronous sleep or request-body read.

2. **Implement comprehensive submission validation.**
   - Collect the request body as buffers, decode once, and parse JSON with controlled error handling.
   - Require the media type `application/json`, accepting case-insensitive spelling and parameters such as `charset=utf-8`.
   - Reject malformed JSON, empty bodies, arrays, `null`, and primitives using field `"body"`.
   - For an object, collect every unknown property and every invalid known field rather than stopping at the first error.
   - Validate `input` using JavaScript `.length` and `.trim()` for whitespace detection, but store its original value unchanged.
   - Apply defaults only to absent properties. Reject explicit `null`, numeric strings, booleans, fractions, and out-of-range numbers for numeric fields.
   - Validate a present `Idempotency-Key` against the exact requested expression, including rejecting an empty value. Include header errors alongside other errors that can be established.
   - Return `400` with `error.code: "invalid_request"`, a useful message, and `fields: [{field, message}, ...]`. Finish validation before any database write.

3. **Make job creation and idempotency atomic.**
   - Normalize the validated payload to `{input, steps, failAttempts}`.
   - In a `BEGIN IMMEDIATE` transaction, look up the supplied key. Compare the three normalized values directly against the original immutable submission values.
   - For an identical payload, return the original job’s current representation with `200`; for a mismatch, return `409 idempotency_conflict`.
   - Otherwise insert one queued job with a server-generated `randomUUID()`, attempts/progress zero, null output/error, and matching creation/update timestamps.
   - Enforce key uniqueness in SQLite as well as in application logic. Null keys permit unlimited independent submissions.
   - Capture the new job representation inside the transaction and return that snapshot with `201`. A worker may claim it immediately after commit, but the creation response must still describe the newly queued job.
   - Keep the key on the durable job row so replay survives server restarts.

4. **Complete HTTP routing and lifecycle.**
   - Identify the route from the URL pathname before checking its method.
   - Support `GET /`, `GET /health`, `GET/POST /api/jobs`, and `GET /api/jobs/:id`.
   - Return JSON `404 not_found` for unknown paths or missing job IDs. Return JSON `405 method_not_allowed` for unsupported methods on known route patterns, including `/` and `/health`; optionally include an `Allow` header.
   - List jobs by insertion sequence descending. Return the same serializer output from creation, replay, listing, and detail endpoints.
   - Report worker `"up"` only when a stored heartbeat is no more than 3 seconds old; absent or stale heartbeat means `"down"`. The server must never generate worker heartbeats.
   - Retain the existing HTML URL relative to `import.meta.url`; it resolves from both `src/server.ts` and compiled `dist/server.js`.
   - Catch asynchronous handler failures and return a JSON internal-error envelope when possible, without crashing the server or leaking database details.
   - On SIGTERM/SIGINT, stop accepting connections, allow active requests a bounded drain period, close remaining connections if necessary, and close SQLite after request handlers stop using it.

5. **Implement the worker state machine.**
   - Initialize SQLite independently and publish a heartbeat immediately, then approximately every 500 ms, including while idle, processing, and waiting for retries.
   - Poll approximately every 100 ms. Atomically select and claim the oldest queued job whose persisted retry deadline has elapsed.
   - Claiming changes status to running, increments attempts, resets progress to zero, clears output/error, and updates the timestamp. Process only one job at a time.
   - For each step, await approximately 100 ms. If the attempt number is at most `failAttempts`, fail on the first step before writing any progress.
   - Otherwise persist each completed step and timestamp. Commit the final step and completed state together, with output computed using JavaScript `input.toUpperCase()`.
   - On a simulated failure before attempt 3, return the same job to queued with progress zero, null output/error, and a durable eligibility deadline 500 ms later.
   - On the third simulated failure, persist failed status, attempts 3, progress zero, null output, and exactly `"transient failure"`.
   - Select only eligible queued work; retries retain their original creation order, while jobs waiting for their deadline do not prevent other eligible jobs from running.

6. **Recover interrupted processing and shut down predictably.**
   - The required deployment has one worker process. On worker startup, recover any persisted running job before claiming fresh queued work.
   - Treat recovery as continuation of the already-counted interrupted attempt: restart its steps from zero while preserving its attempt number. This avoids inventing a transient failure or a fourth attempt when a successful third attempt was interrupted.
   - Reapply the attempt’s failure rule and persist progress normally. With immediate recovery and 100 ms steps, an interrupted job can finish comfortably within the restart deadline.
   - Preserve retry deadlines across restarts and never select completed or failed jobs.
   - On SIGTERM/SIGINT, stop claiming work and exit the processing loop at a step boundary. Leave an interrupted job durably running for startup recovery, clear the heartbeat, stop timers, and close SQLite.
   - On SIGKILL, rely on committed SQLite state and heartbeat expiry; do not depend on shutdown callbacks for durability.

7. **Build the browser interface.**
   - Create the exact requested test IDs: `job-form`, `job-input`, `job-steps`, `job-fail-attempts`, `job-submit`, `form-error`, and `job-list`.
   - Default the numeric fields to 5 and 0. Use `novalidate` so browser validation does not conceal API rejection messages; avoid input limits that prevent testing server validation.
   - Submit input unchanged and convert nonempty numeric field values to numbers. Send an invalid value such as `null` for an empty numeric field rather than coercing it to zero or silently applying a default.
   - POST JSON without an idempotency key for ordinary form submissions. Disable the submit button only while its request is pending.
   - Clear `form-error` when beginning a new submission and after success. On rejection, show the API message and every `fields` entry, including its field name, in this `role="alert"` region.
   - Fetch jobs on page load, after successful submission, and approximately every 500 ms. Serialize refreshes or ignore stale responses so older responses cannot overwrite newer state.
   - Render one `job-item` per job with `data-job-id`, in API order. Include `job-status`, `job-progress` formatted exactly as `completed/total`, and `job-result` containing output, terminal error, or an empty string as appropriate.
   - Insert all submitted text, output, and errors with `textContent`, not HTML interpolation. Keep polling failures from erasing submission-validation messages, and resume polling after temporary failures.

8. **Build and verify the finished implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Use temporary databases and Node built-in HTTP/fetch scripts for the additional cases below. Do not modify fixed checks or introduce dependencies.
   - Inspect the browser page manually for form submission, errors, ordering, and live updates. Confirm the final source changes are confined to `src/` and `ui/`.

## Behaviours to verify
- **Startup and configuration:** Start either process first with a fresh nested `DATABASE_PATH`; then start both simultaneously. Confirm readiness within 10 seconds and correct custom/default ports.
- **Validation:** Exercise missing/blank/overlong input, emoji length boundaries, unknown fields, numeric strings, fractions, explicit nulls, arrays, malformed JSON, absent/wrong content type, and invalid keys. Check all offending field names and unchanged job count.
- **Defaults and exact input:** Submit only `input`; check defaults and preservation of surrounding whitespace. Verify Unicode output matches JavaScript uppercase behavior.
- **Routing:** Test wrong methods on every known route and unknown paths. Confirm status codes, error codes, and JSON content types.
- **Idempotency:** Replay omitted versus explicit defaults, replay after completion and restart, change each payload field, and issue concurrent requests with the same key. Confirm one ID and one row; no-key submissions create separate jobs.
- **Ordering and processing:** Queue multiple jobs before starting the worker. Check oldest-first processing, newest-first listing, pickup within one second, attempts/progress reset, and observable intermediate progress.
- **Retries:** Test `failAttempts` 0 through 5. Verify attempt counts 1, 2, or 3; queued retry delays; zero progress on failed attempts; exact terminal error; and no duplicate jobs/results.
- **Health:** Observe down without a worker, up while idle and busy, and down within roughly 3 seconds after SIGKILL.
- **Durability:** Restart both processes with the same database after graceful shutdown and SIGKILL. Check queued, waiting-retry, running, completed, and failed jobs. Interrupt a successful third attempt specifically; verify recovery without a fourth atte
[truncated]