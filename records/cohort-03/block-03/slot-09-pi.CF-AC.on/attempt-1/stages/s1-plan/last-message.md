# Plan

## Approach
Keep the existing TypeScript entry points, npm commands, and HTML location. Use `node:sqlite` for all shared state, with short transactions for job creation, claims, retries, and completion. Run one asynchronous processing loop in the separate worker, with database heartbeats independent of job availability. Serve a dependency-free browser page that submits through the API and polls for changes.

## Files
- `src/db.ts`: Extend database initialization with schema, indexes, transactions, and typed job persistence helpers.
- `src/jobs.ts` (new): Define public job types, payload validation, normalized payload comparison, and row-to-JSON mapping.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health checks, and shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, delayed retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Add the required form, job list, error display, polling, and modest inline styling.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Initialize shared durable storage from either process.**
   - Preserve directory creation, `busy_timeout` before WAL initialization, and the configured/default database path.
   - Use `CREATE TABLE/INDEX IF NOT EXISTS` so either process can initialize an empty database.
   - Store jobs with an insertion sequence, unique public UUID, input, steps, fail-attempt count, status, attempts, completed-step count, nullable output/error, ISO timestamps, and numeric `available_at`.
   - Store an optional unique idempotency key on the job row. SQLite permits multiple `NULL` values, allowing unrestricted unkeyed submissions.
   - Add a singleton heartbeat row with the worker’s last-seen epoch milliseconds.
   - Index queued work by status, availability, and insertion order. Use insertion sequence descending for listing and ascending for eligible queued work, avoiding timestamp ties.
   - Use prepared statements and a transaction helper that rolls back on failure. Never hold a transaction across a timer or HTTP body read.

2. **Centralize representation and validation.**
   - Map database rows to exactly the public job shape; never expose scheduling, sequence, or idempotency columns.
   - Derive `progress.total` from `steps`; expose output only for completed jobs and error only for failed jobs.
   - Validate parsed data as a non-null, non-array object. Reject every unknown own property.
   - Require a string input with JavaScript length 1–1000 and nonempty `trim()`, but preserve the original string.
   - Apply numeric defaults only when fields are absent. Reject `null`, strings, booleans, fractions, and out-of-range values; use `Number.isInteger`.
   - Accumulate field errors rather than stopping at the first invalid property.
   - Validate any present idempotency key against the exact regex, including rejecting an empty value.
   - Compare normalized submissions by the three validated values, preserving input whitespace and case.

3. **Implement the HTTP contract.**
   - Read the existing HTML through the module-relative path, which works from `dist/server.js`.
   - Match pathname independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and exactly one ID segment under `/api/jobs/`.
   - Dispatch allowed methods after matching the route: unknown routes return JSON `404 not_found`; unsupported methods on recognized routes return JSON `405 method_not_allowed`, optionally with `Allow`.
   - Serve `/` as HTML. Use a common JSON response/error helper for all API and routing responses.
   - For submission, accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` validation error.
   - Collect request chunks and decode UTF-8 once before parsing. Empty or malformed JSON and non-object JSON produce `"body"` errors. Include independently detectable key/body-field errors in the same validation response.
   - Validate before performing any database mutation or idempotency lookup.
   - Inside `BEGIN IMMEDIATE`, look up the key if supplied. Return the existing job with `200` when normalized values match, or `409 idempotency_conflict` otherwise. If absent, insert one UUID-assigned queued job and commit.
   - Build the `201` response from the inserted queued snapshot inside that transaction, so a fast worker cannot change the creation response to `running`.
   - Implement list and detail reads through the same serializer; missing IDs return `404`.
   - `/health` reports `up` only when a stored heartbeat is no more than 3 seconds old; missing/stale heartbeat means `down`.
   - Catch request-handler failures so malformed requests cannot crash the process. Unexpected failures return a structured JSON server error without exposing SQL details.

4. **Implement sequential processing and retries.**
   - Write an immediate heartbeat on worker startup and refresh it approximately every 500 ms while idle, processing, or waiting for retries.
   - Poll for eligible jobs every 100 ms. Claim the oldest queued row whose `available_at <= now` in a short write transaction.
   - A fresh claim atomically changes status to running, increments attempts, resets progress to zero, clears result/error, and updates `updatedAt`.
   - Await approximately 100 ms per step, then persist its completion. Keep the event loop available for signals and heartbeat updates.
   - At the first step, after that delay but before incrementing progress, simulate failure when `attempts <= failAttempts`.
   - For failed attempts 1 and 2, atomically return the same job to queued with zero progress, null result/error, and `available_at = now + 500 ms`.
   - On failure of attempt 3, atomically set failed with error `"transient failure"`, null result, and attempts 3.
   - On successful intermediate steps, persist progress and timestamp. On the final step, atomically write completed status, full progress, and JavaScript `input.toUpperCase()` output.
   - During retry delays, allow other eligible queued jobs to run; never sleep while holding a database lock.

5. **Handle restarts and shutdown explicitly.**
   - On worker startup, recover any existing running job before claiming fresh work. Replay its interrupted logical attempt from step zero using its persisted attempt number; recovery itself does not consume a transient-failure retry.
   - This preserves the three-attempt budget even if the third attempt was interrupted, while allowing the interrupted job to finish. Ordinary retries still increment attempts on their next queued-to-running transition.
   - Keep retry availability timestamps durable so restarting does not reset a waiting retry.
   - Never select completed or failed jobs for processing.
   - On worker `SIGTERM`/`SIGINT`, stop claiming work, stop heartbeat timers, and exit after the current short step boundary. Leave unfinished work durably running for recovery; clear the heartbeat and close SQLite.
   - On server signals, stop accepting connections, allow active handlers to finish with a bounded shutdown fallback, then close SQLite. Guard against repeated shutdown calls and in-flight handlers accessing a closed database.
   - Rely on SQLite transaction atomicity for `SIGKILL`; no correctness-critical cleanup should depend on a signal handler.

6. **Build the browser page.**
   - Add the form and all required `data-testid` attributes. Initialize numeric fields to steps 5 and failAttempts 0.
   - Use `novalidate` so native form constraints do not prevent API validation errors from reaching the required alert region.
   - Submit input verbatim. Convert nonempty numeric fields with `Number`, without `parseInt` truncation; preserve blank values as invalid rather than accidentally converting blank failAttempts to zero.
   - Clear `form-error` when beginning a new submission and after success. On API rejection, show its message and every offending field’s name using `textContent`.
   - Fetch jobs immediately on load and refresh approximately every 500 ms. Serialize refreshes or discard stale responses so a slow response cannot overwrite newer state.
   - Refresh immediately after successful submission; prevent duplicate form submissions while the request is pending.
   - Render newest-first items carrying `data-job-id`, with exact status text, progress formatted as `completed/total`, and result/error text only in the appropriate terminal state.
   - Use DOM creation and `textContent` for all user-controlled strings. Handle temporary fetch failures without stopping future polling or overwriting submission-validation errors.

7. **Build and verify the complete contract.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - Use additional local Node HTTP/process probes and browser inspection for the gaps below. The supplied checks cover only selected examples; do not modify them.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both concurrently against a fresh nested `DATABASE_PATH`; confirm readiness within 10 seconds and a nondefault `PORT`.
- **Validation:** Exercise malformed JSON, arrays/null/primitives, missing/wrong content type, unknown fields, numeric strings, fractions, boundaries, whitespace-only input, and invalid keys. Submit multiple invalid fields together and verify each appears, with no new job.
- **Exact input semantics:** Submit surrounding whitespace, non-ASCII text, and Unicode case mappings; verify stored input is unchanged and output equals JavaScript `toUpperCase()`.
- **Routing:** Check every allowed endpoint, unknown paths, missing IDs, and wrong methods; verify status, error code, and JSON content type.
- **Idempotency:** Check implicit versus explicit defaults, changed values, parallel same-key requests, and replay after server/both-process restarts. Confirm one job per key and separate jobs without keys.
- **Ordering and progress:** Queue several jobs before starting the worker; verify oldest-first processing and newest-first listing. Poll a 20-step job frequently to observe running status and intermediate progress.
- **Retries:** Test failAttempts 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0, 1, and 2; terminal failure at attempt 3 for values 3–5. Observe queued retry delays and zero progress on simulated failures.
- **Heartbeat:** Confirm up during idle work and retries; kill the worker and confirm down after the freshness window, then up after restart.
- **Durability:** Kill both processes with queued, running, waiting-retry, and terminal jobs present. Restart using the same database; verify recovery within the required time, preserved IDs/keys, and unchanged terminal jobs. Repeat with graceful shutdown and interruption during attempt 3.
- **Browser:** Verify every required selector, submission values and field errors, newest-first rendering, and status/progress updates within 2 seconds. Test HTML-like input to confirm it displays as text.
- **Shutdown:** Signal the actual Node processes or their process groups; confirm prompt exit without orphan workers, lingering timers, or database-close errors.

## Risks
- **Recovery versus retry accounting:** Treat replay after a crash as recovery of the persisted logical attempt; blindly incrementing on every restart can exhaust or exceed the three-attempt budget.
- **Database races:** Keep key lookup/insertion and job selection/claim atomic. A unique key alone does not replace transactional replay/conflict handling.
- **SQLite contention:** Preserve WAL and busy timeout, keep transactions short, and perform no asynchronous work inside them.
- **Premature heartbeat staleness:** Maintain heartbeat independently of queue activity and retry waits.
- **Validation coercion:** Apply defaults only to absent fields and never coerce API values. Browser numeric conversion must not silently repair invalid inputs.
- **Incomplete verification:** Passing the provided suites does not establish restart durability, full validation, observable progress, or browser compliance.
- **Worker scope:** The task specifies one worker process. Startup recovery assumes the previous worker has exited; supporting concurrent workers would require ownership/lease protection before recovering running jobs.