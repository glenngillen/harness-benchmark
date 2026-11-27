# Plan

## Approach
Extend the existing TypeScript entry points using Node.js built-ins only. Both processes initialize the same SQLite schema; the server handles HTTP and submissions, while the worker polls SQLite, records heartbeats, and processes one job at a time. Persist progress, retry deadlines, and idempotency keys so restarts require no in-memory reconstruction. Keep database transactions short and implement the browser page with inline JavaScript polling the API.

## Files
- `src/db.ts`: Preserve database opening and directory creation; add schema initialization, transactions, typed row conversion, and shared database operations.
- `src/jobs.ts`: Add job/public-response types, payload validation, normalization, and canonical payload comparison.
- `src/server.ts`: Implement routing, JSON errors, submission/idempotency, health, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, queue selection, processing, retries, recovery, and shutdown.
- `ui/index.html`: Implement the form, error region, job list, and periodic refresh.
- Leave all fixed files, dependencies, commands, and `checks/` unchanged.

## Steps
1. **Initialize durable storage from either process.**
   - Retain `DATABASE_PATH`, parent-directory creation, and `busy_timeout` before enabling WAL.
   - Run idempotent schema creation in `openDatabase()`. Use `synchronous=FULL` for durable commits.
   - Create a jobs table containing an insertion sequence, unique public UUID, status, input, steps, fail-attempt count, attempt count, completed steps, nullable output/error, ISO timestamps, retry-eligibility timestamp, nullable unique idempotency key, and canonical payload.
   - Use insertion sequence for deterministic ordering when timestamps tie: descending for listing, ascending for queue selection.
   - Create a singleton worker-heartbeat table containing the last heartbeat time.
   - Centralize serialization so every job response has exactly the public shape, including explicit nulls and `progress.total = steps`. Never expose internal scheduling or idempotency columns.

2. **Implement complete validation before any submission mutation.**
   - Accept `application/json` case-insensitively, allowing parameters such as `charset=utf-8`; missing or other media types produce a `"body"` error.
   - Read the complete request body, parse JSON safely, and require a non-null, non-array object.
   - Collect all detectable errors: unknown properties, missing/invalid input, invalid numeric fields, and an invalid `Idempotency-Key`. Include `{field, message}` for every offending field; malformed JSON or a non-object body uses `"body"`.
   - Validate input using JavaScript string length and `trim()` only to detect whitespace-only input; retain the original string.
   - Apply numeric defaults only when the property is absent. Reject nulls, booleans, numeric strings, fractions, and out-of-range values.
   - Validate a supplied key against the exact required regex, rejecting duplicate header values rather than silently selecting one.
   - Canonicalize validated payloads using a fixed property order with defaults applied.

3. **Implement atomic submissions and API routing.**
   - Use `BEGIN IMMEDIATE` for the idempotency lookup and insertion, with rollback on exceptions and no asynchronous work inside the transaction.
   - Existing key plus matching canonical payload returns the current original job with `200`; differing payload returns `409 idempotency_conflict`.
   - Otherwise insert a UUID job with queued status, zero attempts/progress, null output/error, and matching creation/update timestamps. Capture the inserted queued representation inside the transaction and return `201`, even if the worker claims it immediately afterward.
   - Implement list, single-job lookup, and health endpoints. Health reads the database heartbeat and reports up only when it is at most three seconds old.
   - Route by pathname independently of query strings. Recognize `/`, `/health`, `/api/jobs`, and single-segment `/api/jobs/:id`; return `405 method_not_allowed` for unsupported methods on these paths and `404 not_found` elsewhere.
   - Serve `/` as HTML; return JSON with the required error envelope for API responses and routing failures. Catch asynchronous handler failures so malformed requests cannot crash the process.
   - Preserve the existing UI file lookup relative to `import.meta.url`, which works from `dist/server.js`.

4. **Implement worker scheduling and observable progress.**
   - Write a heartbeat immediately at startup and every 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms. Select the oldest queued job whose persisted retry deadline has passed.
   - Atomically claim it, setting running status, incrementing attempts, resetting progress, clearing result/error, and updating its timestamp.
   - Wait approximately 100 ms for each step without holding a database transaction. Commit progress after each step.
   - On the final successful step, atomically set completed status, full progress, and `input.toUpperCase()` as output.
   - If the attempt number is at most `failAttempts`, wait for the first step’s duration and fail before recording any progress.
   - For attempts one and two, return the job to queued with a retry deadline 500 ms ahead and null public error/result. After the third simulated failure, set failed status and exactly `"transient failure"`.
   - Continue servicing eligible jobs while another job waits for its retry deadline. Never select completed or failed jobs.

5. **Handle interrupted processing and process shutdown.**
   - Recovery belongs exclusively to worker startup; starting the server must never reset running jobs.
   - Before claiming new queued jobs, recover persisted running work. Replay an interrupted logical attempt from progress zero while retaining its already-recorded attempt number; subsequent transient-failure retries increment normally. This avoids exceeding the three-attempt budget merely because the process restarted, including when interrupted during attempt three.
   - Persist each transition atomically so an abrupt death leaves either the previous state or the complete new state, never a completed job without its output.
   - On worker `SIGTERM`/`SIGINT`, stop claiming jobs, interrupt waits, preserve unfinished running work for recovery, stop heartbeat updates, clear the heartbeat, and close SQLite. Do not turn a shutdown into a simulated failure.
   - On server shutdown, stop accepting connections, finish active handlers, close idle connections, then close SQLite. Bound draining so stalled clients cannot prevent clean exit.
   - Use `finally` cleanup and avoid forcing process exit before database operations finish.

6. **Build the browser page.**
   - Include every required `data-testid`, with `data-job-id` on each job item and `role="alert"` on `form-error`.
   - Give numeric fields defaults of 5 and 0. Submit numeric conversions explicitly; convert blank numeric entries to an invalid value such as null rather than accidentally treating an empty failure field as zero.
   - Use `novalidate` and avoid input restrictions that prevent the API from returning its required validation errors.
   - Clear the error region before submission and after success. On rejection, show the error message and every returned field name/message.
   - Fetch jobs immediately, after successful submission, and every 500 ms. Prevent overlapping refreshes or stale responses from replacing newer state.
   - Render newest-first items with status, `completed/total`, and output/error as specified. Use `textContent` for all user-controlled content.
   - Keep polling after temporary network errors and keep list rendering separate from the form so refreshes do not disrupt editing.

7. **Build and verify the completed implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with local HTTP/process probes and a browser walkthrough covering the cases below. Use isolated temporary databases and terminate spawned processes afterward.
   - Keep any added verification source under `src/` if committing it; do not edit fixed checks or package scripts.

## Behaviours to verify
- **Either startup order and missing directories:** Start each process first against a fresh nested database path; verify readiness within ten seconds and eventual worker-up health.
- **Validation:** Exercise malformed JSON, arrays/null, wrong content type, unknown fields, multiple simultaneous errors, numeric strings, boundary lengths/ranges, whitespace-only input, and invalid keys. Check `fields` and unchanged job count.
- **Representation and routing:** Check explicit nulls, ISO timestamps, deterministic newest-first ordering, missing IDs, unknown paths, and wrong methods.
- **Idempotency:** Submit identical keys concurrently, replay with explicit versus omitted defaults, change each payload field, and restart the server before replaying. Verify one job per key and fresh jobs without keys.
- **Progress and output:** Poll a 20-step job frequently enough to observe intermediate progress. Verify preserved input whitespace and JavaScript Unicode uppercasing.
- **Retries:** Test `failAttempts` from 0 through 5; verify expected terminal status, attempt count, zero progress on simulated failures, retry delays, and one unchanged job ID.
- **Durability:** Kill the worker during processing and during retry waiting, restart with the same database, and verify recovery within the required bound. Repeat after stopping both processes; ensure terminal jobs never change.
- **Health and shutdown:** Kill the worker and verify health becomes down after three seconds; restart and verify up. Send SIGTERM to both processes and verify prompt clean exits.
- **Browser contract:** Submit successful and rejected jobs; inspect all required selectors, field-specific errors, progress/status updates within two seconds, terminal output/error, and newest-first ordering.

## Risks
- **Transactions spanning timers:** They block the other process and delay health/progress. Commit before every wait.
- **Read-then-insert idempotency races:** Prevent them with a write transaction and a database uniqueness constraint.
- **Restart attempt accounting:** Treat recovery as replay of the interrupted logical attempt; test interruptions during the third attempt explicitly.
- **Lost retry delays:** Store deadlines in SQLite rather than relying on an in-memory timeout.
- **Hidden validation gaps:** Check property presence rather than truthiness, aggregate field errors, and never trim stored input.
- **Insufficient visible checks:** The supplied suites omit browser behavior, restart durability, and many edge cases; passing them alone is insufficient.