# Plan

## Approach
Keep the existing TypeScript entry points and commands, using Node.js built-ins exclusively. Put schema initialization, persistence operations, and job serialization in shared modules so the HTTP server and worker can start independently against the same SQLite file. Use short database transactions for creation, idempotency, and worker state changes; never hold a transaction across a processing delay. Serve a self-contained browser page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend the existing connection helper with schema initialization, typed database operations, transactions, and heartbeat persistence.
- `src/jobs.ts`: Add shared job/payload types, validation, and conversion from database rows to the required public representation.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement queue polling, processing, retries, heartbeat updates, recovery, and graceful shutdown.
- `ui/index.html`: Add the form, error region, job list, styling, and inline browser JavaScript.
- Leave all fixed files and `checks/` untouched; add no dependencies.

## Steps
1. **Define the schema and shared representation.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout = 5000` before enabling WAL.
   - Both entry points call the same initializer using `CREATE TABLE/INDEX IF NOT EXISTS`.
   - Store jobs with an integer insertion sequence, unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric `available_at` retry timestamp.
   - Use the insertion sequence for deterministic newest-first listing and oldest-first processing, including submissions sharing a timestamp.
   - Store the worker heartbeat separately as a singleton row containing a timestamp in epoch milliseconds. Schema initialization must not refresh the heartbeat.
   - Use parameterized SQL. Centralize serialization so internal columns never leak and every endpoint returns the exact required shape, including explicit `null` values and `progress.total = steps`.

2. **Implement complete submission validation.**
   - Read request bytes fully and decode UTF-8 once; catch malformed JSON and request-stream failures.
   - Require the media type `application/json`, allowing case-insensitive matching and parameters such as `charset=utf-8`.
   - Require a non-null, non-array JSON object. Use `"body"` for media-type, parsing, or whole-body errors.
   - Enumerate own keys and report every unknown field. Validate all recognized fields independently and collect every offending field.
   - Require `input` to be a string with JavaScript length 1–1000 and nonempty `trim()`, but preserve the original input.
   - Apply numeric defaults only when a property is absent. Reject null, booleans, numeric strings, fractional values, and out-of-range values.
   - Validate any supplied `Idempotency-Key` against the exact regex and name it `"Idempotency-Key"` in errors. Reject duplicated key headers rather than silently selecting one.
   - Return `400 invalid_request` with a message and `fields` before any job mutation. Combine header and payload issues when both can be assessed.

3. **Implement atomic creation and idempotency.**
   - Normalize validated payloads into `{ input, steps, failAttempts }`.
   - In a short `BEGIN IMMEDIATE` transaction, look up any supplied key:
     - Matching stored input, steps, and fail-attempt count: return the existing job with `200`.
     - Different normalized payload: return `409 idempotency_conflict`.
     - Missing key: insert a new job using `randomUUID()`, queued status, zero attempts/progress, null result/error, and current timestamps.
   - Keep a database uniqueness constraint on the key as the final duplicate-prevention mechanism. SQL `NULL` permits independent submissions without keys.
   - Capture the newly inserted row inside the transaction and return that queued snapshot with `201`; a worker may claim it immediately after commit.
   - Always roll back failed transactions. Replays return the original job’s current state without updating its timestamps.

4. **Complete HTTP routing and lifecycle.**
   - Match paths separately from allowed methods:
     - `/`: `GET`, HTML.
     - `/health`: `GET`, JSON health.
     - `/api/jobs`: `GET` and `POST`.
     - `/api/jobs/:id`: `GET`.
   - Recognized paths with unsupported methods return `405 method_not_allowed`, preferably with an `Allow` header. Unknown paths and missing jobs return `404 not_found`.
   - Parse URLs safely and handle malformed encoded IDs without crashing.
   - Use one JSON response/error helper with `Content-Type: application/json; charset=utf-8`. Unexpected handler errors become structured `500` responses.
   - Health reports `"up"` only when the stored heartbeat is at most 3 seconds old; absent or stale heartbeats mean `"down"`.
   - Preserve the existing `new URL('../ui/index.html', import.meta.url)` lookup, which works from the compiled `dist/server.js`.
   - On `SIGTERM`/`SIGINT`, stop accepting connections, finish active requests, close the database, and exit. Bound draining so stalled clients cannot prevent shutdown.

5. **Implement the worker state machine.**
   - Initialize the database, recover interrupted work, and write a heartbeat immediately. Refresh it about every 500 ms during idle time, processing, and retry waits.
   - Poll about every 100 ms when idle. Select the oldest queued job whose `available_at` has passed, and claim it in a short transaction.
   - A new attempt atomically sets `running`, increments attempts, resets completed steps to zero, clears result/error, and updates `updatedAt`.
   - Process one job at a time using asynchronous 100 ms delays. Do not busy-wait or sleep inside a transaction.
   - After the first delay, if the attempt number is at most `failAttempts`, fail before writing any progress:
     - Attempts 1 or 2: atomically return to queued, retain zero progress and null result/error, and persist `available_at = now + 500 ms`.
     - Attempt 3: atomically set failed, error `"transient failure"`, and null result.
   - Otherwise persist progress after each delay. On the final step, atomically write completed progress, completed status, and `input.toUpperCase()`.
   - Refresh `updatedAt` on each job state/progress transition, not on heartbeats.
   - Waiting retries must not block other eligible queued jobs.

6. **Make recovery and shutdown explicit.**
   - For the required single-worker deployment, startup can immediately recover rows left running by the previous worker; no server participation or external communication is needed.
   - Requeue interrupted attempts below the three-attempt limit with zero progress and immediate availability; the next claim increments attempts normally.
   - If the interrupted row already records attempt 3, recover that recorded attempt from step zero without allocating attempt 4. Apply its failure predicate normally. This treats recovery of the final interrupted attempt as continuation and avoids either abandoning successful work or exceeding the retry cap.
   - Preserve persisted retry deadlines for jobs already queued. Never alter completed or failed jobs during startup.
   - On termination, stop claiming work and allow the current attempt to finish—at most about 2 seconds with 100 ms steps. Persist its completion or retry transition, clear the heartbeat, cancel timers, and close SQLite.
   - Ensure abrupt termination also works: each committed step survives, the stale heartbeat expires, and startup recovery handles the running row.

7. **Build the browser page.**
   - Include every specified `data-testid`, with `role="alert"` on `form-error` and `data-job-id` on each job item.
   - Give numeric fields defaults of 5 and 0. Use `novalidate` so API validation errors reach the alert instead of being intercepted by native form validation.
   - Submit input unchanged and convert numeric fields with `Number`; represent an empty numeric field as `null` so it is rejected rather than silently interpreted as zero.
   - Clear the form alert before each submission. On API rejection, display its message and every returned field name/message; preserve the entered values.
   - Fetch the list on load, after submission, and about every 500 ms. Use a single-flight refresh mechanism to prevent overlapping requests and stale responses overwriting newer state.
   - Render jobs in API order, with exact status text, `completed/total`, output for completed jobs, error for failed jobs, and empty result content otherwise.
   - Use DOM creation and `textContent` for all submitted text and server messages. Do not interpolate job data into HTML.
   - Keep background polling failures separate from submission validation errors, and continue polling after temporary failures.

8. **Build and verify the finished implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Use temporary databases for additional lifecycle and HTTP checks; the disclosed suites explicitly omit substantial validation, persistence, and UI coverage.
   - Keep any added verification source under `src/` or `ui/`, or run one-off commands without changing fixed files.

## Behaviours to verify
- **Independent startup:** Start each process first on a fresh nested database path, then the other; repeat simultaneous startup. Both become ready within 10 seconds.
- **Health:** Server alone reports down; running and idle workers report up; killing the worker produces down after heartbeat expiry.
- **Creation and representation:** Check all fields, explicit nulls, defaults, exact preservation of whitespace around valid input, ISO timestamps, and deterministic listing order.
- **Validation:** Exercise malformed JSON, arrays/null/scalars, missing/wrong content type, unknown fields, missing input, whitespace-only input, length boundaries, numeric strings, nulls, fractions, range boundaries, and invalid keys. Combine multiple invalid fields and verify none creates a job.
- **Idempotency:** Submit the same key concurrently, replay with explicit defaults and reordered properties, conflict on each payload field, and replay after restarting the server. Verify exactly one job exists; keyless submissions remain distinct.
- **Routing:** Check unknown paths, missing IDs, and wrong methods on every known route, including `/` and `/health`.
- **Processing:** Poll a 20-step job frequently enough to observe running state and intermediate progress; verify each ordinary step takes about 100 ms and completion uses JavaScript uppercase semantics.
- **Retries:** Test `failAttempts` from 0 through 5. Values 0–2 complete in 1–3 attempts; values 3–5 fail on attempt 3. Verify queued retry delays, zero failure progress, and no duplicated jobs/results.
- **Durability:** Stop and restart both processes using the same database. Kill the worker during processing and retry waiting, then restart it. Verify recovery, retained retry deadlines, persistent idempotency, and unchanged terminal jobs.
- **Shutdown:** Send `SIGTERM` while idle and processing; verify prompt clean exit and restartability.
- **Browser:** Submit valid and invalid jobs using the required selectors, inspect offending field names, observe updates within 2 seconds, reload to recover the list, and verify HTML-like input renders as text.

## Risks
- **Interrupted third-attempt semantics:** The task does not explicitly distinguish crash recovery from a new attempt at the retry limit. Implement and verify the continuation policy above so recovery cannot create attempt 4 or falsely fail work that should succeed.
- **SQLite contention:** Keep transactions short, initialize safely from either process, retain the busy timeout, and never hold locks during awaited delays.
- **Creation-response races:** Return the captured insertion snapshot for `201`; querying again after commit can accidentally return running status.
- **Validation coercion:** Defaults apply only to absent fields. Avoid truthiness checks and server-side numeric conversion.
- **Heartbeat gaps:** Keep heartbeat refresh independent of queue eligibility and processing waits; health must remain accurate during long jobs.
- **Incomplete verification:** Passing the existing smoke and contract checks is necessary but does not establish restart, UI, timing, or full validation correctness.