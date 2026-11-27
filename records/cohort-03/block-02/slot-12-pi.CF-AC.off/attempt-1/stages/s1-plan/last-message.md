# Plan

## Approach
Extend the existing TypeScript server, worker, and HTML page using only Node.js built-ins. Both processes will initialize the same SQLite schema independently, with short transactions protecting job creation, idempotency, and state transitions. The worker will persist progress, retry scheduling, and a heartbeat; the server will expose that state through one shared job serializer. The browser will submit through the API and poll for updates.

## Files
- `src/db.ts`: Preserve `openDatabase`; add schema initialization, typed row mapping, and transactional job operations.
- `src/jobs.ts`: Add job and payload types, validation, canonical payload comparison, and the public job serializer.
- `src/server.ts`: Implement routing, JSON request handling, validation, idempotent submission, health reporting, and shutdown.
- `src/worker.ts`: Implement sequential processing, heartbeat updates, delayed retries, restart recovery, and shutdown.
- `ui/index.html`: Add the submission form, required test attributes, error display, job rendering, and polling.
- Leave all fixed files and `checks/` unchanged. Preserve the existing build and startup entry points.

## Steps
1. **Create the shared database schema.**
   - Retain directory creation and the existing ordering of `PRAGMA busy_timeout = 5000` before enabling WAL.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from `openDatabase`, so either process can start first.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempt count, completed-step count, nullable output/error, ISO creation/update timestamps, and an integer `available_at` timestamp.
   - Store a nullable unique idempotency key and its canonical payload on the job row. SQLite permits multiple `NULL` keys, allowing unkeyed submissions.
   - Add a singleton worker-state row containing the latest heartbeat timestamp.
   - Index queued-job selection. Use insertion sequence for deterministic oldest/newest ordering even when timestamps tie.
   - Use parameterized statements throughout. Keep transactions synchronous and short; never hold one across a processing delay.

2. **Centralize validation and job serialization.**
   - Validate parsed values as `unknown`; reject `null`, arrays, and primitives with field `"body"`.
   - Require `input` to be a string with JavaScript length 1–1000 and a nonempty `trim()` result. Store the original string without trimming.
   - Apply numeric defaults only when the property is absent. Explicit `null`, strings, booleans, fractions, and out-of-range values are invalid.
   - Collect all offending fields, including every unknown own property. Use an explicit allowed-field set rather than prototype-sensitive membership checks.
   - Validate a supplied `Idempotency-Key` against the exact required expression; reject empty, oversized, invalid, or repeated header values with field `"Idempotency-Key"`.
   - Normalize valid payloads into a fixed-order object containing `input`, `steps`, and `failAttempts`, then serialize it for exact idempotency comparisons.
   - Serialize every job response through the same function. Expose only the specified fields; derive `progress.total` from `steps`, return `{output}` only for completed jobs, and expose `error` only for failed jobs.

3. **Implement HTTP routing and submission.**
   - Resolve the pathname independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one nonempty ID segment.
   - Classify paths before checking methods: unknown paths return JSON `404 not_found`; known paths with unsupported methods return JSON `405 method_not_allowed`, optionally with `Allow`.
   - Serve `/` as HTML using the existing `new URL('../ui/index.html', import.meta.url)` resolution, which works from `dist/server.js`.
   - Return JSON content type and the prescribed error envelope for all API responses and routing errors.
   - Accept case-insensitive `application/json`, including parameters such as `charset=utf-8`. Missing or different media types produce `400 invalid_request` with `"body"`.
   - Read the complete request asynchronously, handling stream errors and malformed/empty JSON. Accumulate header and payload validation errors where the body can be parsed; create no database records for invalid requests.
   - For valid submissions, use `BEGIN IMMEDIATE`:
     - Look up any supplied key.
     - If present, compare canonical payloads and return the current original job with `200`, or `409 idempotency_conflict`.
     - Otherwise insert a UUID job with status `queued`, zero attempts/progress, null result/error, and current timestamps.
     - Capture the inserted row before committing and return that snapshot with `201`, ensuring the creation response remains queued even if the worker immediately claims it.
   - Implement job listing ordered by insertion sequence descending and individual lookup with `404` for missing IDs.
   - Add a top-level async request error handler that returns a JSON internal-error response when possible and logs diagnostic details without terminating the server.

4. **Implement worker liveness and normal processing.**
   - Write a heartbeat immediately after initialization and at least every 500 ms while idle, processing, or waiting for retries.
   - `/health` reads the stored heartbeat and reports `"up"` only when it is no more than 3 seconds old; missing/stale values mean `"down"`.
   - Use one sequential worker loop, polling about every 100 ms when no work is ready.
   - Select the oldest queued job whose `available_at <= Date.now()`. Future retries should not block other eligible jobs.
   - Atomically claim the selected job in a short transaction: set `running`, increment attempts, reset progress to zero, clear result/error, and update `updatedAt`.
   - Wait approximately 100 ms per step using asynchronous timers. Commit completed-step progress and `updatedAt` after every successful step.
   - On the final successful step, atomically store full progress, `completed`, and `input.toUpperCase()`. Never select completed or failed jobs.

5. **Implement transient failure and durable retry scheduling.**
   - At the first step, after its approximately 100 ms delay and before incrementing progress, fail when the current attempt number is at most `failAttempts`.
   - If fewer than three attempts have started, persist `queued`, zero progress, null result/error, and `available_at = failure time + 500 ms`.
   - On the third simulated failure, persist `failed`, zero progress, null result, and error exactly `"transient failure"`.
   - Keep retry scheduling in SQLite, not solely in timers, so server or worker restarts preserve the delay and attempt history.
   - Update the same job row throughout; never insert a retry job or separate result record.

6. **Recover interrupted work and shut down cleanly.**
   - On worker startup, recover persisted `running` work before claiming queued jobs. Under the specified single-worker deployment, these rows belong to the previous worker process.
   - Replay an interrupted attempt from step zero using its already-persisted attempt number; treat this as recovery of that attempt rather than a newly scheduled transient retry. This avoids exceeding the three-attempt limit when a worker dies during attempt three.
   - Reset progress/result/error and update the timestamp before replay. Apply the same first-step failure rule, and continue normally. Recovery should begin immediately, comfortably within the restart allowance.
   - Preserve queued retry deadlines and leave terminal jobs untouched.
   - On worker `SIGTERM`/`SIGINT`, stop claiming work, cancel or finish the current short timer, leave interrupted work recoverable, stop heartbeat updates, clear the heartbeat, and close SQLite. Do not fabricate a transient failure because of shutdown.
   - On server shutdown, stop accepting connections, allow active handlers to finish, then close SQLite. Bound shutdown for stalled connections so the process exits promptly.
   - Keep initialization and shutdown independent of the other process being present.

7. **Build the browser interface.**
   - Add `job-form`, `job-input`, `job-steps` (default 5), `job-fail-attempts` (default 0), and `job-submit`.
   - Add an initially empty `form-error` region with `role="alert"` and a `job-list` container.
   - Use `novalidate` so browser constraints do not prevent API validation from producing the required errors.
   - Submit the exact input string and numeric field values as JSON. Convert nonempty numeric values with `Number`; use an invalid value such as `null` for blanks so an empty fail-attempt field does not silently become zero.
   - Clear form errors before each submission. On rejection, show the API message plus every returned field name and message using `textContent`. Handle network failures visibly as well.
   - Refresh the list immediately after submission and on initial page load, then poll about every 500 ms. Serialize refreshes or discard stale responses so older responses cannot overwrite newer state.
   - Render jobs in API order. Each `job-item` carries `data-job-id`; its descendants expose `job-status`, `job-progress` as `completed/total`, and `job-result` as output, failure error, or empty text.
   - Render user-controlled content with DOM creation and `textContent`, never interpolated HTML. Preserve form values and focus during list refreshes.

8. **Validate the finished implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the supplied checks with local HTTP, process-restart, and browser exercises below; the current checks explicitly omit restart durability, the browser, and many validation cases.
   - Use temporary database paths and free ports for additional checks. Do not alter the supplied checks or fixed configuration files.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate runs, including simultaneous startup with a nonexistent database parent directory. Confirm readiness within 10 seconds and custom `PORT`/`DATABASE_PATH` support.
- **Validation:** Exercise missing/blank/oversized input, Unicode string lengths, numeric strings, fractions, nulls, boundaries, unknown properties, malformed JSON, arrays, missing/wrong content type, and invalid keys. Verify every relevant field is named and job count is unchanged.
- **Routing and response shape:** Check all endpoints, unknown paths, unsupported methods, absent IDs, JSON content types, ISO timestamps, and exact result/error nullability.
- **Idempotency:** Send simultaneous matching submissions with one key, omitted versus explicit defaults, and different payloads. Confirm one ID, `201` only for creation, `200` replays, `409` conflicts, and persistence after server restart. Unkeyed submissions must remain distinct.
- **Processing and ordering:** Queue multiple jobs before starting the worker; observe oldest-first claims and newest-first listing. Poll a 20-step job frequently to confirm visible intermediate progress, roughly 100 ms steps, and uppercase Unicode output.
- **Retries:** Check `failAttempts` values 0, 1, 2, 3, and 5. Expected terminal attempt counts are 1, 2, 3, 3, and 3; the last two fail with the exact required error. Observe zero-progress failures, queued retry delays, and no duplicate jobs.
- **Health:** Run server alone, start the worker, then kill it. Confirm down → up → down, with stale liveness expiring within approximately 3 seconds even during long jobs.
- **Durability:** Stop both processes with `SIGTERM` and separately `SIGKILL`, then restart with the same database. Verify queued, retrying, completed, and failed state persists; interrupt running work, including attempt three, and confirm bounded recovery without reprocessing terminal jobs.
- **Browser:** Submit successful and failing jobs, observe updates without reload within 2 seconds, verify all required selectors, and trigger API validation errors with offending field names. Confirm HTML-like input renders as literal text.
- **Shutdown:** Send `SIGTERM` to each actual Node process and verify prompt exit, closed database handles, and no lost committed state.

## Risks
- **SQLite startup and write races:** Preserve busy-timeout-before-WAL initialization, use idempotent DDL, unique key constraints, and short explicit transactions with rollback on errors.
- **Accidental extra attempts during recovery:** Keep replay of an interrupted attempt distinct from a transient retry; never reset attempt history or allow an ordinary fourth attempt.
- **Unobservable progress or stale health:** Use asynchronous step delays and persistent per-step updates; maintain heartbeat activity independently of queue availability.
- **Validation shortcuts:** Do not coerce API numeric strings, use truthiness for defaults, trim stored input, or stop after the first invalid field.
- **Creation response races:** Return the row captured during insertion, rather than rereading after the worker can claim it.
- **Incomplete verification:** Passing the supplied contract suite alone does not establish browser correctness or restart durability; perform the additional checks above.