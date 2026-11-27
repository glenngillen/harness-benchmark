# Plan

## Approach
Implement the API and worker with Node.js built-ins and a shared SQLite database, retaining the existing entry points and commands. Put schema initialization and job serialization in shared modules so either process can start first. Use short transactions for submission, claiming, and state transitions; persist retry deadlines and heartbeat timestamps. Serve a dependency-free browser page that submits JSON and polls for updates.

## Files
- `src/db.ts`: Extend the existing database opener with idempotent schema initialization, transaction helpers, and typed database operations. Preserve parent-directory creation and `busy_timeout` before WAL initialization.
- `src/jobs.ts` (new): Define payload/job types, validation, normalized payload comparison, and the public job serializer.
- `src/server.ts`: Implement routing, body parsing, validation, idempotent submission, job reads, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, durable retries, interrupted-attempt recovery, heartbeat updates, and graceful shutdown.
- `ui/index.html`: Add the required form, error region, job list, and polling script.
- Leave configuration, dependencies, commands, and `checks/` unchanged.

## Steps
1. **Define the persistent model and public representation.**
   - Create tables with `CREATE TABLE IF NOT EXISTS` from the shared database initializer.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, failure simulation count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric retry eligibility timestamp.
   - Generate public IDs with `node:crypto.randomUUID()`. Use the insertion sequence for deterministic newest-first listing and oldest-first selection, including jobs created in the same millisecond.
   - Store the worker heartbeat in a singleton row with an epoch-millisecond timestamp.
   - Serialize every returned job through one function: expose only the specified fields, derive `progress.total` from `steps`, return `{output}` only for completed jobs, and return an error only for failed jobs.
   - Use parameterized statements. Keep transactions synchronous, with rollback on exceptions; never hold a transaction across a timer or request-body read.

2. **Implement comprehensive submission validation.**
   - Read the complete request body before parsing; catch malformed JSON and request stream errors without allowing unhandled promise rejections.
   - Accept media type `application/json` case-insensitively, allowing parameters such as `charset=utf-8`; missing or other media types produce a `"body"` error.
   - Require a non-null, non-array JSON object. For a valid object, collect all field violations instead of stopping after the first.
   - Enumerate own properties to reject every unknown field. Check presence explicitly so omitted optional values receive defaults, while explicit `null`, strings, and other wrong types fail.
   - Validate `input` using JavaScript `.length` and `.trim()` without changing the stored value. Require numeric integer ranges for the other two fields.
   - Validate a present `Idempotency-Key` against the exact required expression; an empty or repeated/comma-joined header is invalid. Include its field error alongside body-field errors where available.
   - Return `400` with `error.code = "invalid_request"`, a useful message, and the complete `fields` array. Perform no writes until validation succeeds.

3. **Implement atomic creation and idempotency.**
   - Normalize successful validation to `{input, steps, failAttempts}` with defaults applied.
   - In a short `BEGIN IMMEDIATE` transaction, look up a supplied key. Compare the three normalized values directly with the original job’s immutable submission values.
   - Return the original job’s current representation with `200` for a match, or `409 idempotency_conflict` for a mismatch.
   - Otherwise insert one queued job with zero attempts/progress and null output/error. Capture its initial public representation in the transaction, commit, then return it with `201`; do not reread after commit, when the worker could already have claimed it.
   - Enforce uniqueness in SQLite as well as application logic. Bind absent keys as SQL `NULL`, allowing every unkeyed submission to create a job.
   - Keep keys and original payload values permanently, including for terminal jobs.

4. **Complete HTTP routing and process lifecycle.**
   - Recognize `/`, `/health`, `/api/jobs`, and exactly one ID segment after `/api/jobs/`. Match paths before checking methods so known paths return `405` and unknown paths return `404`.
   - Support GET for `/`, `/health`, and individual jobs; support GET and POST for `/api/jobs`. Optionally include an `Allow` header with `405`.
   - Return the required JSON error envelope for API errors, missing jobs, unknown paths, and wrong methods. Use a common JSON response helper with `application/json; charset=utf-8`.
   - Read health directly from SQLite: missing or older-than-three-seconds heartbeat means `"down"`; a fresh heartbeat means `"up"`.
   - Preserve the existing HTML file lookup relative to `import.meta.url`, which works from `dist/server.js`. Only the successful page response uses HTML content type.
   - Catch asynchronous handler failures and return a JSON `500` without exposing database internals.
   - Retain the server handle. On SIGTERM/SIGINT, stop accepting requests, finish active handlers, close connections as needed within a bounded shutdown period, then close SQLite. Avoid closing the database while a handler still uses it.

5. **Implement sequential worker processing and heartbeat.**
   - Initialize the schema and write a heartbeat immediately. Refresh it every approximately 500 ms while idle, processing, or waiting for retry eligibility.
   - Poll approximately every 100 ms. In a short transaction, select the oldest eligible queued job, set it to running, increment attempts, reset progress, clear output/error, and update its timestamp.
   - Process only one job at a time. Sleep asynchronously for approximately 100 ms before each step, allowing heartbeat timers to run.
   - If the attempt number is at most `failAttempts`, fail after the first step’s delay but before incrementing progress.
   - Otherwise persist each completed step separately. Commit the final progress value and completed status/output together, using JavaScript `input.toUpperCase()`.
   - On simulated failure before attempt three, persist status `queued`, zero progress, null output/error, and a retry deadline 500 ms in the future. On the third simulated failure, persist status `failed`, error `"transient failure"`, and null output.
   - Select queued jobs by insertion order among jobs whose retry deadline has arrived. Waiting retries must not make newly submitted eligible jobs wait for an unnecessary sleep.
   - Update `updatedAt` on every job state/progress transition; leave `createdAt` unchanged.

6. **Recover durable work and shut down safely.**
   - On worker startup, inspect persisted running jobs before taking new queued work. The task uses one worker process; recovery belongs to the worker, never server startup.
   - Treat a persisted running job as an interrupted, unfinished attempt: reset its progress and rerun that durable attempt from its first step, retaining its attempt number. This avoids manufacturing a fourth retry when a worker dies during attempt three; subsequent simulated failures follow the normal retry rules.
   - Persist retry deadlines so restarting cannot erase the required delay. An overdue retry is immediately eligible.
   - Never reset or select completed/failed jobs. Do not clear the database during initialization.
   - On SIGTERM/SIGINT, set a stopping flag and stop claiming jobs. Check it after each short sleep and leave unfinished work durably running for recovery. Clear heartbeat timers, clear the heartbeat row, close SQLite, and exit naturally.
   - For SIGKILL, rely on committed state and heartbeat expiry. Recover interrupted work immediately on the next worker startup, comfortably inside the ten-second recovery allowance.

7. **Build the browser page.**
   - Add a form with `job-form`, input controls with `job-input`, `job-steps`, and `job-fail-attempts`, and a `job-submit` button. Initialize numeric controls to 5 and 0.
   - Add an always-present, initially empty `form-error` region with `role="alert"`, plus `job-list`.
   - Use `novalidate` so native constraints do not prevent the API from returning required validation errors. Send the input unchanged and numeric values as JSON numbers; avoid `parseInt`, which would silently truncate decimals or accept partial strings. Send empty/unparseable numeric entries as an invalid value such as `null`, not as an accidental default.
   - On submission, clear stale errors and POST JSON. For rejection, display the server message and every offending field name/message using text nodes. Leave the error region empty after successful submission.
   - Fetch the list initially, immediately after successful submission, and approximately every 500 ms. Serialize refreshes or discard stale responses so older responses cannot overwrite newer state.
   - Render newest-first items with `job-item` and `data-job-id`, containing the required status, `completed/total` progress, and result/error elements. Keep result text empty for queued/running jobs.
   - Use `textContent` for submitted input, results, and error messages. Keep form controls outside the refreshed list so polling preserves typed values and focus.

## Behaviours to verify
- **Existing commands:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The existing suites create isolated databases and launch both processes; they do not cover the whole task.
- **Startup/configuration:** Start server first, worker first, and both together against a fresh nested `DATABASE_PATH`. Verify readiness within ten seconds and the default configuration.
- **Validation:** Exercise malformed/empty JSON, arrays, null, missing/non-JSON content type, unknown fields, numeric strings, fractions, limits, whitespace-only input, and invalid keys. Combine several violations and verify all offending fields appear and job count does not change.
- **Exact values:** Submit surrounding whitespace, Unicode, and boundary-length strings. Confirm input preservation, JavaScript string-length validation, and JavaScript uppercase output.
- **Routes:** Check unknown paths, unsupported methods on every known path, missing IDs, response status codes, and JSON error content types.
- **Idempotency:** Replay a key with omitted versus explicit defaults, change each payload field, issue simultaneous matching submissions, and restart the server. Verify one ID/job per key and a new job for every unkeyed submission.
- **Scheduling/progress:** Queue several jobs without a worker, then start it. Poll a 20-step job frequently enough to observe intermediate progress and confirm FIFO selection, sequential execution, and prompt idle pickup.
- **Retries:** Check `failAttempts` 0, 1, 2, 3, and 5. Verify attempt counts, zero progress on simulated failures, observable queued retry delays, completion on attempt three for 2, and the exact terminal error for 3 or more.
- **Durability:** Stop and restart both processes using SIGTERM and SIGKILL against the same file. Include queued, running, retry-waiting, completed, and failed jobs; kill during the third attempt too. Verify preserved IDs, recovery, and no terminal reprocessing.
- **Health/shutdown:** Verify worker-down before startup, up during long work/retries, down within three seconds after SIGKILL, and clean SIGTERM exit without lingering timers or locked database handles.
- **Browser:** Submit successful and invalid forms, confirm every required test ID and field-level rejection, observe u
[truncated]