# Plan

## Approach
Extend the existing TypeScript entry points using Node.js built-ins only. Store jobs, idempotency keys, retry deadlines, and worker heartbeats in SQLite, with shared initialization so either process can start first. Use short transactions for submissions and worker state transitions, and asynchronous timers between processing steps. Serve a self-contained browser page that submits through the API and polls for updates.

## Files
- `src/db.ts`: Extend database initialization with schema creation, prepared queries, transactions, and shared job serialization.
- `src/jobs.ts`: Add job types, request validation, default normalization, and structured API error helpers.
- `src/server.ts`: Implement routing, JSON request handling, durable idempotency, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat updates, sequential processing, persisted retry delays, interrupted-job recovery, and shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, polling, and minimal styling.

Leave all fixed files and `checks/` untouched. Preserve the existing build commands, entry-point names, and relative imports compatible with the current TypeScript configuration.

## Steps
1. **Define the database schema and public representation.**
   - Keep parent-directory creation and the existing ordering of `busy_timeout` before enabling WAL.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both processes.
   - Store jobs with an insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempt count, completed steps, output, error, ISO timestamps, and an internal numeric `available_at` retry deadline.
   - Store a nullable, unique idempotency key on each job. Compare its immutable input, steps, and fail-attempt count directly; no separate payload hash is necessary.
   - Add a singleton worker heartbeat row containing the last heartbeat time.
   - Use insertion sequence for deterministic ordering when timestamps tie: descending for API lists, ascending for worker selection.
   - Provide one serializer for the exact public job shape. Exclude internal columns; construct `progress`, return `{output}` only for completed jobs, and expose an error only for failed jobs.
   - Use bound SQL parameters and a transaction helper that always rolls back on errors. Never hold a transaction across an `await`.

2. **Implement complete request validation before touching job state.**
   - Accept the `application/json` media type case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Read the complete request body safely, parse it as JSON, and reject malformed JSON, `null`, arrays, and primitives using `"body"`.
   - For object bodies, collect all offending fields instead of returning only the first error. Iterate own keys to reject every unknown property.
   - Require a string input with JavaScript length 1–1000 and a nonempty trimmed value. Store the original string without trimming.
   - Apply numeric defaults only when a property is absent. Reject `null`, numeric strings, non-integers, and values outside the specified bounds.
   - Validate a present `Idempotency-Key` against the exact pattern, including rejecting an empty value; report `"Idempotency-Key"`.
   - Include `fields` in every `invalid_request` response. Validate submissions before performing idempotency lookup, so an invalid replay cannot bypass validation.

3. **Implement the HTTP routes and atomic submission behavior.**
   - Match the URL pathname independently of its query string.
   - Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment. Dispatch allowed methods explicitly; return structured JSON `405 method_not_allowed` for other methods on these paths and `404 not_found` for unknown paths.
   - Serve the existing HTML file location for `GET /`; all API responses and routing errors use JSON content type.
   - For POST, normalize the validated payload, then run a short `BEGIN IMMEDIATE` transaction:
     - If the key exists and payload matches, read and return the original job’s current state with `200`.
     - If the key exists and payload differs, return `409 idempotency_conflict` without inserting.
     - Otherwise insert a UUID job with `queued`, zero attempts/progress, null result/error, defaults applied, and both timestamps set.
   - Construct the new-job response from its inserted snapshot inside the transaction, then commit and send `201`. This guarantees that the creation response remains `queued` even if the worker immediately claims it.
   - Enforce uniqueness in SQLite as well as application logic. Unkeyed requests always insert.
   - Implement list and detail reads through the shared serializer.
   - Return health `"up"` only when a persisted worker heartbeat is at most 3 seconds old. Server startup must never manufacture a worker heartbeat.
   - Catch asynchronous request failures and return structured JSON errors when the connection remains writable; do not allow malformed requests to terminate the server.

4. **Implement the worker’s durable state machine.**
   - Initialize the database and write a heartbeat immediately. Refresh it about every 500 ms throughout idle time, processing, and retry waits.
   - Poll for work about every 100 ms. Select the oldest queued job whose `available_at` has passed; delayed retries must not block other eligible work.
   - Atomically claim a selected job using a short transaction and guarded update. Set `running`, increment attempts, reset progress to zero, clear result/error, and update the timestamp.
   - Process one job at a time. Await approximately 100 ms for each step, then commit its progress so concurrent HTTP reads can observe it.
   - At the first step, after its delay but before progress advances, simulate failure when `attempts <= failAttempts`.
   - For failed attempts 1 and 2, atomically return the same job to `queued`, keep progress zero and result/error null, and persist `available_at = now + 500 ms`.
   - For a failed third attempt, atomically set `failed`, error `"transient failure"`, null result, and attempts 3.
   - On the successful final step, atomically persist completed progress, `completed`, and `input.toUpperCase()` output. Do not use SQLite’s uppercase function.
   - Update `updatedAt` on job-state changes, not heartbeat writes.

5. **Make restart and shutdown behavior explicit.**
   - Under the task’s single-worker model, recover any existing `running` job before selecting new queued work. Restart its computation from step zero as recovery of the already-counted interrupted attempt; retain its attempt number and apply the same failure rule. This prevents a crash during attempt 3 from introducing a fourth retry or discarding an otherwise successful job.
   - Persisted queued retry deadlines survive restarts. Never select completed or failed jobs for processing.
   - Recovery begins immediately on worker startup, comfortably within the required 10-second allowance.
   - On worker `SIGTERM`/`SIGINT`, stop taking new work, exit at the next step boundary, stop heartbeat timers, clear the heartbeat, and close SQLite. Leave interrupted work durably `running` for recovery.
   - On server shutdown, stop accepting connections, allow active handlers to finish, then close SQLite. Bound shutdown for stalled clients by closing lingering connections after a short grace period.
   - Use `try/finally` for database and timer cleanup. Abrupt termination requires no cleanup for correctness: committed SQLite state and heartbeat expiry handle it.

6. **Build the browser page around the specified selectors.**
   - Add a form with `job-form`, a labeled text input or textarea with `job-input`, numeric fields with `job-steps` and `job-fail-attempts`, and `job-submit`. Initialize numeric defaults to 5 and 0.
   - Use `novalidate` so browser constraint validation does not suppress API rejection feedback.
   - Submit exact input text and numeric conversions of the two numeric fields using JSON. Treat empty numeric fields deliberately rather than silently converting an empty string to zero; send an invalid value such as `null` so the API reports the field.
   - Keep an initially empty `form-error` element with `role="alert"`. Clear it when starting a submission and after success; on rejection show the API message and every field name/message. Polling must not clear a submission rejection.
   - Fetch jobs on initial load, after successful submission, and approximately every 400–500 ms. Serialize refreshes or guard response ordering so an older fetch cannot overwrite newer state.
   - Render newest-first jobs inside `job-list`, each with `job-item` and `data-job-id`.
   - Include `job-status`, `job-progress` formatted exactly as `completed/total`, and `job-result` containing output, terminal error, or empty text.
   - Render submitted input, results, and errors with `textContent`, never HTML interpolation. Keep the form outside the refreshed list so polling preserves typing and focus.
   - Handle fetch failures without stopping subsequent polling; restore the submit button in `finally`.

7. **Build and validate the implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Supplement the disclosed checks with focused local HTTP, process-restart, and browser checks below. Use isolated database paths and ports; do not modify the provided checks.
   - Inspect the final diff to ensure source changes are confined to `src/` and `ui/`.

## Behaviours to verify
- **Startup and configuration:** Start worker-first, server-first, and simultaneously against a missing nested database directory. Check readiness within 10 seconds and default/custom configuration.
- **Validation:** Exercise every boundary, whitespace-only input, Unicode string lengths, numeric strings, explicit nulls, multiple unknown/invalid fields, malformed JSON, arrays, primitives, missing/wrong content types, and invalid keys. Check field names and unchanged job counts.
- **Representation and routing:** Verify every job-returning endpoint has the exact shape, ISO timestamps, correct nulls, deterministic newest-first order, and JSON errors for unknown paths and wrong methods.
- **Idempotency:** Compare omitted defaults with explicit defaults; submit matching and conflicting requests concurrently; restart the server and repeat. Confirm exactly one job per key and separate jobs without keys.
- **Processing and ordering:** Queue jobs while the worker is stopped, then start it. Observe oldest-first execution, one running job at a time, prompt idle pickup, and incremental progress on a 20-step job.
- **Retries:** Test fail-attempt values 0–5. Expect successful attempt counts 1, 2, and 3 for values 0, 1, and 2; values 3–5 fail on attempt 3 with the exact error. Observe queued retry waits and no duplicate jobs.
- **Heartbeat:** Observe `"down"` without a worker, `"up"` while idle and busy, and `"down"` within 3 seconds after killing it.
- **Durability:** Use both SIGTERM and SIGKILL during processing and retry waits. Restart with the same database; verify recovery, retained terminal jobs, retained keys, and no reprocessing of terminal jobs. Include interruption during the third successful attempt.
- **Browser:** Verify all required selectors, number-valued JSON submissions, error field names, live progress/status within 2 seconds, terminal results, and correct rendering of HTML-like input.
- **Shutdown:** Signal the actual Node processes or their process groups when launched through npm. Confirm prompt clean exit and immediate restart without database-lock failures.

## Risks
- **SQLite contention:** Retain WAL and the busy timeout; keep transactions brief and outside timer waits.
- **Idempotency races:** An in-memory map or separate unprotected lookup/insert is insufficient. Use a unique database constraint and one transaction.
- **Creation-response races:** Serialize the inserted queued snapshot before releasing the transaction rather than rereading after commit.
- **Interrupted attempts:** Distinguish crash recovery of an existing attempt from a retry after a simulated failure; document and test third-attempt recovery.
- **Lost retry timing or false liveness:** Persist deadlines and heartbeat timestamps; never infer worker health from queued/running jobs.
- **Browser validation masking API errors:** Disable native submission blocking and let server responses populate the required alert.
- **Incomplete verification:** The existing contract checks omit browser behavior, restart durability, exhausted retries, and many validation cases; passing them alone is insufficient.