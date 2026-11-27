# Plan

## Approach
Keep the existing TypeScript entry points, npm commands, and single HTML page. Use SQLite as the sole shared state for jobs, idempotency keys, retry scheduling, and worker health, with short transactions for every state transition. The server validates submissions and exposes the API; the worker processes one job at a time using asynchronous timers. The browser polls the API every 500 ms and renders the required elements.

## Files
- `src/db.ts`: Extend the existing database opener with shared, repeatable schema initialization; retain directory creation, busy timeout, and WAL.
- `src/jobs.ts`: Add job types, database row serialization, submission/idempotency transactions, queries, and worker state transitions.
- `src/validation.ts`: Add payload/header validation and normalized submission types.
- `src/server.ts`: Implement routing, JSON request handling, API errors, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, FIFO claiming, progress updates, transient retries, restart recovery, and shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, submission handler, and polling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Define the database schema and public serialization.**
   - Preserve `openDatabase()` and its defaults. Both entry points call the same initializer, allowing either process to start first.
   - Use `CREATE TABLE IF NOT EXISTS` for:
     - `jobs`: monotonically increasing integer sequence, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, and numeric `available_at` for retry scheduling.
     - Store a nullable, unique idempotency key on each job. SQLite permits multiple `NULL` keys.
     - `worker_health`: singleton row containing the last heartbeat time in epoch milliseconds.
   - Use the sequence for deterministic newest-first listing and oldest-first scheduling, including jobs created in the same millisecond.
   - Centralize conversion to the exact public job shape. Internal columns must not leak into responses. Return `result` only for completed jobs and `error` only for failed jobs.
   - Use prepared statements and bound parameters. Keep transactions synchronous and short; never hold a transaction over a timer or request-body read.

2. **Implement complete submission validation.**
   - Read the body as bytes, concatenate, then decode as UTF-8 and parse JSON; catch malformed JSON and stream errors.
   - Require the media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Missing or unsupported content type produces a `"body"` field error.
   - Reject `null`, arrays, and JSON primitives with a `"body"` error.
   - Enumerate all own keys and report every unknown field. Validate all known fields without stopping at the first error.
   - Require `input` to be a string of JavaScript length 1–1000 with `input.trim().length > 0`; store the original string unchanged.
   - Apply defaults only when `steps` or `failAttempts` is absent. Explicit `null`, strings, fractions, and out-of-range numbers are errors.
   - Validate a present `Idempotency-Key` against the exact specified regex, including rejecting an empty value. Report the header name exactly as `"Idempotency-Key"`.
   - Return `400 invalid_request` with a meaningful message and a `fields` array containing each offending field. Validate before consulting or changing idempotency state.

3. **Implement atomic creation and persistent idempotency.**
   - Use `BEGIN IMMEDIATE` around the key lookup and possible insert, with rollback on exceptions.
   - For an existing key, compare the stored input, steps, and fail-attempt count against the validated, defaulted payload. Return the existing job’s current representation with `200`, or `409 idempotency_conflict` for a difference.
   - Otherwise insert a job with `randomUUID()`, status `queued`, attempts/progress zero, null output/error, and matching creation/update timestamps.
   - Capture the inserted queued representation inside the transaction and return it with `201`; do not reread after commit, when the worker could already have claimed it.
   - Keep the unique database constraint as protection against concurrent submissions. Requests without a key always insert.
   - Never delete idempotency mappings when a job finishes or a process restarts.

4. **Complete HTTP routing and lifecycle.**
   - Match the URL pathname independently of the query string.
   - Known paths and methods:
     - `/`: `GET`, serving the existing HTML file via the existing module-relative path.
     - `/health`: `GET`.
     - `/api/jobs`: `GET` and `POST`.
     - `/api/jobs/:id`: `GET`, matching exactly one nonempty ID segment.
   - Recognize the route before checking its method. Unsupported methods on known paths return `405 method_not_allowed`; unknown paths return `404 not_found`.
   - Detail lookup returns `404 not_found` for an absent job. List returns `{ jobs: [...] }` ordered by descending sequence.
   - Use a common JSON response/error helper, including for unexpected request-handler failures. Catch asynchronous handler errors so malformed requests cannot crash the server.
   - Health is `up` only when the persisted heartbeat is no more than 3000 ms old; missing or stale heartbeats mean `down`.
   - Retain `PORT` default `3000`. On `SIGTERM`/`SIGINT`, stop accepting connections, finish active handlers, close the database, and exit. Bound connection draining so idle or incomplete requests cannot keep the process alive indefinitely.

5. **Implement the single-worker processing loop.**
   - Write a heartbeat immediately at startup and every 500 ms while idle, processing, or waiting for retries.
   - Poll for eligible work every 100 ms. Atomically select the oldest queued job whose `available_at <= Date.now()` and transition it to running.
   - A fresh attempt increments `attempts`, resets completed progress to zero, clears output/error, and updates `updatedAt`.
   - Wait approximately 100 ms for each step using asynchronous timers.
   - If the attempt number is at most `failAttempts`, fail after the first step’s delay, before recording any progress:
     - Attempts 1 and 2: return to `queued`, keep progress zero and error/result null, and persist `available_at = now + 500 ms`.
     - Attempt 3: set `failed`, attempts 3, error `"transient failure"`, and null result.
   - Otherwise persist completed progress after each step. On the final step, atomically set progress to `steps`, status to completed, and output to JavaScript `input.toUpperCase()`.
   - Update `updatedAt` for each state change. Completed and failed jobs never enter the claim query.
   - A delayed retry is ineligible until its persisted deadline; meanwhile the worker may process another eligible job.

6. **Make interrupted work recoverable and shutdown predictable.**
   - Under the task’s single-worker model, inspect persisted running work at worker startup before claiming new jobs. The server must never reset running jobs.
   - Recover an interrupted running attempt by restarting its step sequence at zero using its persisted attempt number. Treat this as recovery of the already-counted attempt, so a crash during attempt 3 cannot accidentally start attempt 4 or falsely fail an otherwise successful job.
   - Apply the same failure predicate and terminal transitions during recovery. Preserve queued retry deadlines across restarts.
   - With immediate recovery and 100 ms steps, recovery starts well inside the 10-second allowance.
   - On worker termination, stop claiming jobs, cancel or finish the current short timer, clear heartbeat scheduling, and close SQLite only after outstanding worker callbacks finish.
   - Leave interrupted running work durable for startup recovery; invalidate the heartbeat on graceful shutdown. After `SIGKILL`, heartbeat expiry reports the worker down.
   - Document the assumption of one worker process; supporting overlapping live workers would require ownership leases rather than unconditional startup recovery.

7. **Build the browser page and interaction.**
   - Add every required `data-testid` exactly as specified. Include associated labels, a textarea for input, numeric fields defaulting to 5 and 0, and an initially empty `form-error` with `role="alert"`.
   - Use `novalidate` so browser constraints do not suppress API validation and field errors.
   - On submission, clear the form error and send JSON. Convert numeric field values to numbers; represent blank/invalid numeric input as an invalid value such as `null` rather than silently converting a blank fail-attempt field to zero.
   - Disable submission while its request is pending and re-enable it afterward. On rejection, show the API message plus every field name and message. On success, clear the error and refresh the list.
   - Fetch the list on load and every 500 ms with nonoverlapping requests. Coordinate submission-triggered refreshes so an older response cannot overwrite a newer list.
   - Render newest first with one `job-item` carrying `data-job-id` per job. Render status, `completed/total`, and output/error in their required child elements.
   - Use DOM creation and `textContent` for all submitted input, result, and error text. Keep form values intact during list updates.
   - Catch polling/network errors and continue polling after recovery; use a separate connection message if needed so polling does not overwrite submission errors.

8. **Build and verify the finished implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The provided checks cover only examples; supplement them with the cases below using fresh temporary database paths and the browser.
   - Keep any committed supplemental verification source under `src/` if needed; do not modify the existing checks or configuration.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both together with a nonexistent database parent directory. Confirm readiness within 10 seconds and the configured port/path are respected.
- **Validation:** Submit malformed JSON, primitives, arrays, missing content type, unknown fields, whitespace-only input, explicit nulls, numeric strings, fractional/out-of-range values, and invalid keys. Combine several invalid fields and confirm all are named and the job count is unchanged.
- **String semantics:** Verify surrounding whitespace is preserved, JavaScript string-length boundaries are enforced, and Unicode output equals `input.toUpperCase()`.
- **Response contract and routing:** Inspect all job fields, JSON content types, missing IDs, unknown paths, and wrong methods on each known route.
- **Idempotency:** Compare omitted versus explicit defaults; send concurrent identical-key requests; reuse a key with different payloads; restart the server and replay again. Exactly one job must exist.
- **Ordering and progress:** Queue several jobs before starting the worker. Confirm FIFO processing, newest-first listing, pickup within one second when idle, and observable intermediate progress on a 20-step job.
- **Retries:** Check fail-attempt values 0 through 5. Expect completion on attempts 1, 2, and 3 for values 0, 1, and 2; values 3–5 fail on attempt 3. Observe queued retry delays and no duplicate jobs.
- **Durability:** Terminate actual Node processes with both `SIGTERM` and `SIGKILL`, then restart against the same database. Check queued jobs, retry delays, running recovery, terminal state preservation, and idempotent replays. Specifically interrupt a successful third attempt and verify recovery.
- **Health and shutdown:** Observe worker up while idle and busy, down after graceful shutdown or within three seconds of its last heartbeat after abrupt death, and up after restart. Confirm both processes exit promptly on `SIGTERM`.
- **Browser:** Submit valid and invalid jobs, inspect every required test ID, confirm numeric JSON fields, offending field names, and status/progress updates within two seconds. Submit HTML-like text and verify it renders as text.

## Risks
- **Database contention:** Retain busy timeout before switching to WAL, initialize schema identically in both processes, and never await inside a write transaction.
- **Creation races:** Returning a post-commit reread can produce a running job in a `201` response; capture the queued snapshot before releasing the transaction.
- **Retry loss on restart:** Store deadlines and attempt counts in SQLite, not only in timers or memory.
- **Crash versus simulated failure:** Recovery must not consume an extra transient retry merely because the process died; keep interrupted-attempt recovery distinct from starting a new retry.
- **Incomplete validation:** Do not coerce API inputs, default explicit nulls, trim stored input, or stop after the first field error.
- **UI validation bypass and stale rendering:** Let the API reject invalid form values, serialize refreshes, and render user-controlled strings with `textContent`.
- **False confidence from checks:** The disclosed suites omit browser behavior, most validation, and persistence; complete the supplemental checks before declaring the application finished.