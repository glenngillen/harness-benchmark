# Plan

## Approach
Extend the existing TypeScript entry points using only Node.js built-ins, preserving all commands and the `src/` and `ui/` layout. Put schema initialization and durable job operations in shared modules used by both processes; all communication between server and worker goes through SQLite. Use short transactions for submissions and state changes, with asynchronous timers between worker steps. Serve a small browser page that submits jobs and polls their current state.

## Files
- `src/db.ts`: Extend the existing connection setup with shared schema initialization, prepared queries, transactions, and durable worker heartbeat storage.
- `src/jobs.ts` (new): Define job and database-row types, payload validation/defaulting, job serialization, and job state operations.
- `src/server.ts`: Implement API routing, request parsing, idempotent submissions, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, heartbeat updates, retries, interrupted-job recovery, and graceful shutdown.
- `ui/index.html`: Add the submission form, error region, job list, polling, and modest styling.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define shared types and initialize SQLite from either entry point.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before enabling WAL.
   - Run idempotent `CREATE TABLE IF NOT EXISTS` initialization from `openDatabase()`, so either process can start first.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempt count, completed-step count, nullable output/error, ISO timestamps, nullable unique idempotency key, and retry eligibility time in epoch milliseconds.
   - Use the insertion sequence for deterministic ordering when timestamps tie: descending for listing, ascending for processing.
   - Add a singleton worker-heartbeat row containing its last-seen epoch time.
   - Use a common serializer that returns exactly the public representation. Internal scheduling, ordering, and idempotency columns must not leak into responses.
   - Keep database transactions synchronous and short; never hold one while reading HTTP bodies or awaiting timers.

2. **Implement complete submission validation before any mutation.**
   - Accept `application/json` case-insensitively, including normal parameters such as `charset=utf-8`; reject missing or other media types.
   - Read the body, parse JSON, and reject malformed JSON, `null`, arrays, and primitives with field `"body"`.
   - For objects, collect all unknown fields and all invalid recognized fields, rather than stopping at the first error.
   - Require `input` to be a string of JavaScript length 1–1000 and to have nonempty `trim()` output, but store the original string unchanged.
   - Apply defaults only to absent `steps` and `failAttempts`. Validate explicit values using their original types and `Number.isInteger`; reject `null`, numeric strings, fractions, and out-of-range values.
   - Validate a present `Idempotency-Key` against the exact required expression; an empty header is invalid. Include its field error alongside body-field errors when possible.
   - Return the required `invalid_request` envelope with a `fields` array. Invalid submissions must never reserve an idempotency key or insert a job.

3. **Make creation and idempotent replay atomic.**
   - Normalize valid input into the fixed tuple `(input, steps, failAttempts)` after applying defaults.
   - In a `BEGIN IMMEDIATE` transaction, look up any supplied key. If found, compare those three stored values exactly: return the existing job with `200`, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert a job with `crypto.randomUUID()`, status `queued`, attempts and progress zero, null output/error, immediate eligibility, and matching creation/update timestamps.
   - Retain the inserted row’s queued snapshot inside the transaction and return it with `201` after commit. Do not reread afterward: the worker might already have claimed it.
   - Enforce key uniqueness in SQLite as well as in application logic. Without a key, always insert a new row.
   - Roll back on errors. Replay returns the job’s current state, including completed or failed state.

4. **Implement HTTP routing and lifecycle.**
   - Route by URL pathname, independently of query parameters.
   - Implement `GET /health`, `POST /api/jobs`, `GET /api/jobs`, and `GET /api/jobs/:id`.
   - Health reports `up` only when a stored heartbeat is at most 3 seconds old; a missing or expired heartbeat means `down`.
   - Recognize route patterns before checking methods. Known paths with unsupported methods return `405 method_not_allowed`, preferably with `Allow`; unknown paths and missing jobs return `404 not_found`.
   - Keep errors and all API responses JSON with the required envelopes and content type. `GET /` serves HTML.
   - Preserve the existing module-relative `../ui/index.html` lookup, which works from the compiled `dist/server.js`.
   - Catch asynchronous request-handler failures so malformed requests cannot terminate the process. Return a JSON internal-error envelope for unexpected failures without exposing SQL or stack traces.
   - Retain the HTTP server handle. On `SIGTERM` or `SIGINT`, stop accepting connections, allow active handlers to finish, bound lingering connections, and close SQLite after handlers stop using it.

5. **Implement one sequential worker loop with durable scheduling.**
   - Write a heartbeat immediately on startup and refresh it approximately every 500 ms, including while idle and processing.
   - Poll approximately every 100 ms. Claim the oldest eligible queued job atomically, setting `running`, incrementing attempts, resetting progress to zero, clearing output/error, and updating its timestamp.
   - Select only jobs whose persisted retry eligibility time has arrived. A delayed retry need not block another eligible job.
   - For each step, await approximately 100 ms without a database transaction open.
   - At the first step, if the recorded attempt number is at most `failAttempts`, simulate failure before incrementing progress.
   - For an unsuccessful attempt below attempt 3, atomically return the same job to `queued`, retain its attempt count, leave progress zero and result/error null, and set eligibility to approximately 500 ms later.
   - On the third simulated failure, atomically set `failed`, error `"transient failure"`, null result, and attempts 3.
   - Otherwise persist progress after every step. Commit the final progress increment, `completed` status, and `input.toUpperCase()` output together.
   - Update `updatedAt` on every job-state mutation. Never select terminal jobs for processing.

6. **Handle process interruption explicitly.**
   - The task uses one worker process; on worker startup, inspect unfinished `running` jobs before claiming new work.
   - Recover a running job by replaying its interrupted durable attempt from step zero, retaining its recorded attempt number. Treat this as resuming the interrupted attempt, so process crashes do not consume simulated-failure retries or produce a fourth logical attempt.
   - Apply the same first-step failure rule to that recorded attempt. Subsequent retries increment attempts normally.
   - Persist the recovery reset before processing. Recover immediately on startup, comfortably within the recovery deadline, without relying on server activity or an in-memory timer.
   - Persist retry deadlines so queued retries also survive either process restarting.
   - On worker termination, stop claiming work, cancel or finish the short current wait, and leave any interrupted job durably `running` for recovery. Clear the heartbeat, stop timers, then close SQLite.
   - After `SIGKILL`, rely on committed SQLite state and heartbeat expiration; no cleanup handler is assumed to run.

7. **Build the browser page around the API contract.**
   - Include all specified `data-testid` attributes, with `form-error` carrying `role="alert"` and each `job-item` carrying `data-job-id`.
   - Initialize numeric inputs to 5 and 0. Submit their values as JavaScript numbers and the input string unchanged.
   - Use `novalidate` on the form so native constraints do not suppress submissions that should receive API validation errors. Do not silently replace an emptied numeric field with its default; send an invalid value such as `null`.
   - Clear the error region when starting a submission. On API rejection, show its message and every returned offending field name. Preserve entered values on failure.
   - Refresh the list immediately after submission and approximately every 500 ms, rendering the API’s newest-first order.
   - Prevent overlapping list refreshes or discard stale responses so an older response cannot overwrite newer state.
   - Render status, `completed/total`, and completed output or failed error exactly as required; leave result text empty for queued/running jobs.
   - Use DOM construction and `textContent` for all submitted text, output, and errors. Keep the form stable while updating job rows.

8. **Build and verify without changing fixed files.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with temporary external scripts or manual requests and browser checks. The existing contract suite does not cover browser behavior, restart durability, or the full validation matrix.
   - Use isolated temporary database paths and available ports for lifecycle tests, and terminate both processes afterward.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both concurrently using a nested missing database directory and a nondefault port; confirm readiness within 10 seconds.
- **Health:** Check `down` without a worker, `up` while idle and busy, and `down` within slightly more than 3 seconds after killing the worker.
- **Job shape and ordering:** Submit multiple jobs without a worker; verify queued responses, defaults, timestamps, null fields, exact input preservation, unique IDs, and deterministic newest-first listing.
- **Validation:** Exercise every rule, including multiple simultaneous field errors, whitespace-only input, 1000/1001-character boundaries, numeric strings, explicit nulls, unknown fields, malformed JSON, arrays, missing content type, and invalid keys. Confirm the job count does not increase.
- **Idempotency:** Compare omitted and explicit defaults, run concurrent submissions with one key, change each normalized field separately, and replay after server restart. Verify one durable job and the correct `200`/`409` responses.
- **Routing:** Check unsupported methods on every known route, nonexistent IDs, unknown paths, and JSON error content types.
- **Processing:** Poll a 20-step job frequently enough to observe `running` and intermediate progress. Check pickup latency, step timing, exact JavaScript uppercase output, and terminal field consistency.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify attempt counts 1, 2, 3, 3, and 3 respectively, observable queued retry delays, zero progress on simulated failures, and no duplicate jobs.
- **Durability:** Stop and restart both processes with queued, retry-waiting, completed, and failed jobs present. Kill a worker mid-attempt, including during a successful third attempt, then verify recovery and unchanged terminal jobs.
- **Browser:** Submit valid and rejected forms; inspect all required selectors, field names in alerts, automatic progress updates within 2 seconds, final output/error text, and safe rendering of HTML-like input.
- **Shutdown:** Send `SIGTERM` while idle and busy; confirm prompt process exit, no unhandled errors, and intact database state.

## Risks
- **Attempt recovery ambiguity:** Distinguish resuming an interrupted durable attempt from starting a retry. Blindly incrementing on every restart can exceed the three-attempt limit or incorrectly fail an otherwise successful third attempt.
- **SQLite contention:** Preserve busy-timeout setup before WAL/schema operations, use atomic claims and inserts, and never sleep inside transactions.
- **Creation-response race:** Return the queued creation snapshot captured before commit, even if processing starts before the HTTP response reaches the client.
- **Validation shortcuts:** Avoid coercion, truthiness-based defaults, trimming stored input, and early returns that omit other offending fields.
- **Incomplete durability:** Retry deadlines, idempotency keys, progress, and heartbeat must be persisted; in-memory maps or timers cannot be authoritative.
- **UI masking API errors:** Native form validation and silent numeric defaults can prevent the required rejection behavior; route submissions through API validation.
- **Overreliance on supplied checks:** Passing the smoke and contract suites does not establish restart safety, complete validation, or browser compliance.