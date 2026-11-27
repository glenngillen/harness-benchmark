# Plan

## Approach
Keep the existing server and worker entry points and use Node.js built-ins only. Put schema initialization, durable job operations, and job serialization in shared modules, with SQLite as the only communication channel between processes. Use short transactions for submission and job claiming, persisted retry deadlines, and a database heartbeat for worker health. Serve a self-contained browser page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, transaction helpers, and durable job/heartbeat operations.
- `src/jobs.ts`: Add job and payload types, validation, canonical payload comparison, and conversion from database rows to the required API shape.
- `src/server.ts`: Implement routing, request parsing, validation responses, idempotent creation, job queries, health reporting, and shutdown.
- `src/worker.ts`: Implement sequential processing, observable progress, retries, recovery, heartbeat, and shutdown.
- `ui/index.html`: Add the submission form, job list, error region, styling, and inline browser JavaScript.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the shared database schema.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL initialization.
   - Have both processes initialize tables and indexes with `IF NOT EXISTS`, so either can start first.
   - Use a `jobs` table containing an insertion sequence (`INTEGER PRIMARY KEY AUTOINCREMENT`), unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO timestamps, nullable unique idempotency key, and retry eligibility time in epoch milliseconds.
   - Store a canonical payload string alongside the idempotency key, built from a fixed-order object containing `input`, `steps`, and `failAttempts` after defaults.
   - Add a singleton worker-heartbeat table holding the last heartbeat time. Only the worker writes heartbeat state.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first selection, including jobs created within the same millisecond.
   - Keep transactions synchronous and brief; never hold a transaction across a timer or request-body read. Roll back on exceptions.

2. **Implement validation and public serialization.**
   - Parse JSON into `unknown`. Reject null, arrays, primitives, and malformed JSON with a `"body"` field error.
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types.
   - For an object, accumulate errors for every unknown key and every invalid known field. Use own-property checks: defaults apply only to omitted properties, not explicit null.
   - Require `input` to be a string with JavaScript length 1–1000 and nonempty `trim()`, but store the original string unchanged.
   - Require actual integer numbers in the specified ranges; do not coerce strings.
   - Validate any supplied `Idempotency-Key` against the complete specified regex, including rejecting an empty header. Include header errors alongside discoverable body errors.
   - Centralize error responses, always including `fields` for `invalid_request`.
   - Centralize row serialization so every endpoint exposes exactly the specified job fields. Build `progress.total` from `steps`; expose output only as `{ output }` for completed jobs, and error only for failed jobs. Do not expose internal sequence, retry time, or idempotency data.

3. **Implement atomic submission and read operations.**
   - Validate the entire request before consulting idempotency records or inserting anything.
   - Inside `BEGIN IMMEDIATE`, look up a supplied key. Return the original job’s current representation with `200` if canonical payloads match, or `409 idempotency_conflict` if they differ.
   - Otherwise insert one UUID job with status `queued`, attempts/progress zero, null result/error, and equal creation/update timestamps.
   - Capture the inserted job representation inside the transaction and return it with `201` after committing. This guarantees the creation response remains queued even if the worker immediately claims it.
   - Retain the unique key constraint as a database-level guarantee across concurrent submissions and server restarts. Unkeyed submissions always insert a new row.
   - Implement newest-first listing and lookup by public ID using bound SQL parameters.

4. **Complete HTTP routing and server lifecycle.**
   - Route using the URL pathname, independently of query parameters.
   - Support `GET /`, `GET /health`, `GET|POST /api/jobs`, and `GET /api/jobs/:id` with exactly one ID segment.
   - Recognize paths before checking methods: unsupported methods on known routes return `405 method_not_allowed`; unknown paths and missing jobs return `404 not_found`.
   - Return JSON content types for all API responses and routing errors; the successful root page uses HTML.
   - Catch asynchronous body-read and handler failures without terminating the server. Handle disconnected requests without attempting duplicate responses.
   - Health returns `"up"` only when a stored heartbeat is no more than 3 seconds old; no heartbeat or a stale heartbeat means `"down"`.
   - Preserve `PORT`, `DATABASE_PATH`, and the existing module-relative HTML loading path, which also resolves correctly from `dist/server.js`.
   - On `SIGTERM`/`SIGINT`, stop accepting requests, allow active handlers to finish within a bounded shutdown window, close remaining connections if needed, then close SQLite.

5. **Implement the worker state machine.**
   - Write a heartbeat immediately after initialization and refresh it approximately every 500 ms, including during processing and retry waits.
   - Poll for work every 100 ms while idle. Select the oldest eligible queued job (`retry_at <= now`) and atomically mark it running, increment attempts, reset completed steps to zero, and clear result/error.
   - Process only one job at a time using asynchronous 100 ms sleeps.
   - After each sleep, if this attempt number is at most `failAttempts`, fail at the first step before recording progress. Otherwise persist the newly completed step and `updatedAt`.
   - For a transient failure before attempt 3, return the same row to queued with zero progress, null result/error, and `retry_at = now + 500 ms`. The persisted deadline controls eligibility even after restart.
   - For the third transient failure, atomically set status failed, error `"transient failure"`, null result, and attempts 3.
   - On the final successful step, atomically persist completed status, full progress, and `input.toUpperCase()` computed in JavaScript. Do not use SQLite’s `upper()`, which has different Unicode behavior.
   - Update `updatedAt` on job transitions and progress changes, while leaving `createdAt` unchanged.

6. **Recover interrupted work and shut down safely.**
   - Under the task’s single-worker model, inspect running jobs at worker startup and recover them before ordinary queued work.
   - Treat a previously running row as an interrupted attempt: restart its steps from zero while retaining its already-counted attempt number. This reprocesses the job without inventing a transient failure or exhausting the retry budget solely because a process died.
   - Apply the same first-step transient-failure rule to the recovered attempt. After an actual failure, subsequent attempts increment normally.
   - Recovery starts immediately, comfortably within the required 10-second allowance. Never select completed or failed rows.
   - On shutdown, stop claiming jobs and exit at the next short timer boundary, leaving any unfinished job durably running for recovery. Clear the heartbeat on graceful exit, stop timers, and close SQLite.
   - A `SIGKILL` requires no cleanup: committed progress/status survives, the heartbeat expires, and startup recovery handles the interrupted row. Server startup must never reset running jobs.

7. **Build the browser UI.**
   - Add every required `data-testid` exactly as specified, with a textarea for input, numeric fields defaulting to 5 and 0, a submit button, and an initially empty `role="alert"` region.
   - Use `novalidate` so native browser constraints do not suppress the API validation errors the UI must display.
   - Submit all three fields, preserving input text and converting numeric field values to numbers. Ensure blank or unparseable numeric entries reach the API as invalid values rather than silently becoming defaults.
   - On API rejection, render the rejection message and every returned field name/message. Clear the error when a new submission begins and after success.
   - Disable the submit button only while the request is pending, restoring it in `finally`.
   - Fetch jobs on page load, after successful submission, and approximately every 500 ms. Serialize refreshes or ignore stale responses so older responses cannot overwrite newer job state.
   - Render jobs in API order with `data-job-id`, status, exact `completed/total` text, and output/error/empty result as appropriate.
   - Use DOM construction and `textContent` for submitted input, outputs, and errors. Keep polling failures separate from the form rejection region.

8. **Validate the implementation without changing fixed checks.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with temporary local scripts or manual HTTP/browser checks covering the cases below. Use isolated database paths and terminate all spawned processes afterward.

## Behaviours to verify
- **Startup and configuration:** Start worker first, server first, and both simultaneously with a fresh nested database path. Confirm readiness within 10 seconds and the documented defaults.
- **Validation:** Submit malformed JSON, non-objects, missing/wrong content types, unknown fields, nulls, numeric strings, fractional/out-of-range numbers, whitespace-only input, length boundaries, and invalid keys. Combine multiple errors and verify all offending fields appear and job count stays unchanged.
- **Job representation:** Check queued, running, completed, and failed responses from creation, replay, detail, and list endpoints; verify exact null/result/error semantics and ISO timestamps.
- **Idempotency:** Replay omitted versus explicit defaults, change each payload field, submit concurrent requests sharing a key, and replay after server restart. Confirm exactly one job per key and distinct jobs without keys.
- **Processing:** Poll a 20-step job frequently enough to observe intermediate progress and measure pickup and step timing. Queue several jobs and verify sequential oldest-first processing.
- **Retries:** Test `failAttempts` from 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0–2, and failure on attempt 3 for values 3–5. Observe queued retry intervals of approximately 500 ms and no duplicate jobs.
- **Durability:** Kill the worker during progress, during a retry wait, and during its third attempt. Restart with the same database and verify recovery, preserved retry deadlines, and terminal jobs remaining unchanged. Also stop/restart both processes.
- **Health and shutdown:** Observe up while idle and processing, down within 3 seconds after abrupt worker death, and clean process exits on `SIGTERM`.
- **Routes:** Exercise wrong methods on all known routes, unknown paths, missing IDs, and query strings; verify status codes, JSON error shapes, and content types.
- **Browser:** Submit successful and invalid jobs, verify all selectors and field-name errors, observe updates within 2 seconds, reload to confirm persistence, and submit HTML-like text to verify safe rendering.

## Risks
- **SQLite startup contention:** Both processes initialize the database; retain the busy timeout before WAL setup and avoid long transactions.
- **Creation/worker race:** Reading a newly created job after commit can return running status. Capture the queued response before committing.
- **Recovery accounting:** Distinguish resuming an interrupted attempt from retrying a recorded transient failure; never decrement attempts or reprocess terminal jobs.
- **Single-worker recovery assumption:** Startup recovery assumes the previous worker has exited. Do not introduce overlapping worker processes without adding database ownership/leases.
- **UI validation bypassing the API:** Native form constraints or numeric defaults can conceal invalid submissions. Let the API validate and display its structured errors.
- **Incomplete check coverage:** The supplied contract checks omit browser behavior, most validation cases, and restart durability; the additional checks are necessary.