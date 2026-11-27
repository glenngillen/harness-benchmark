# Plan

## Approach
Implement the tracker with Node.js built-ins, keeping the existing server and worker entry points and npm commands. Both processes initialize and use the same SQLite schema; all jobs, retry scheduling, idempotency keys, and worker heartbeats live in the database. Use short atomic database transactions and asynchronous worker delays so HTTP reads can observe progress. Serve a self-contained browser page that submits jobs and polls the API every 500 ms.

## Files
- `src/db.ts`: Extend the existing database initializer with the shared schema, transaction helpers, and database configuration.
- `src/jobs.ts` (new): Define job types, row serialization, submission/idempotency operations, ordered reads, and worker state transitions.
- `src/validation.ts` (new): Validate request bodies and idempotency keys, apply defaults, and produce field errors.
- `src/server.ts`: Implement routing, request parsing, API responses, health checks, page serving, and shutdown.
- `src/worker.ts`: Implement heartbeat updates, sequential processing, persisted retries, recovery, and shutdown.
- `ui/index.html`: Implement the form, error region, job list, polling, and minimal styling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Create the shared schema and database helpers.**
   - Preserve directory creation and the existing order of `busy_timeout = 5000` before enabling WAL. Use `CREATE TABLE/INDEX IF NOT EXISTS` so either process can initialize the database first.
   - Create a `jobs` table containing:
     - Internal integer insertion sequence for deterministic ordering.
     - Unique public string ID generated with `randomUUID()`.
     - `input`, `steps`, `fail_attempts`, `status`, `attempts`, `completed_steps`, nullable output and error, ISO creation/update timestamps.
     - Nullable unique `idempotency_key` and numeric `available_at` timestamp for retry eligibility.
   - Store idempotency keys directly on job rows: SQLite permits multiple `NULL` values in a unique column, so unkeyed submissions remain independent.
   - Create a singleton worker-state table with the last heartbeat timestamp. A missing heartbeat means down.
   - Provide a synchronous transaction wrapper using `BEGIN IMMEDIATE`, `COMMIT`, and rollback on failure. Never hold a transaction across an asynchronous wait.
   - Centralize serialization into the exact public job shape; omit internal fields, derive `progress.total` from `steps`, and expose result/error only for their corresponding terminal statuses.

2. **Implement comprehensive submission validation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`. Missing or other media types produce a `"body"` error.
   - Read the complete request body and parse JSON. Empty/malformed JSON, `null`, arrays, and primitives produce a `"body"` error.
   - For objects, collect every offending field rather than returning on the first error. Check unknown own properties as well as all three supported fields.
   - Require `input` to be a string with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Preserve the original string.
   - Apply numeric defaults only when the property is absent. Reject explicit `null`, strings, booleans, fractions, and values outside the specified ranges.
   - Validate a present `Idempotency-Key` against the exact regex, including rejecting an empty value. Report its error as `"Idempotency-Key"`; combine it with any independently detectable body errors.
   - Return a normalized payload only when validation succeeds. No database mutation occurs for rejected requests.

3. **Make creation and idempotency atomic.**
   - Within one immediate transaction, look up a supplied key and compare its job’s immutable `input`, `steps`, and `failAttempts` against the normalized payload.
   - Return the existing job with `200` for equality or `409 idempotency_conflict` for a difference.
   - Otherwise insert one queued job with attempts/progress zero, null result/error, and matching creation/update timestamps.
   - Capture the inserted job representation before releasing the transaction and return it with `201`. This guarantees the creation response describes a queued job even if the worker immediately claims it.
   - Keep the unique constraint as a database-level safeguard against duplicate keyed submissions across concurrent requests and restarts.

4. **Implement the HTTP routes and lifecycle.**
   - Match URL paths independently of methods, then enforce the allowed methods:
     - `/`: GET HTML.
     - `/health`: GET health JSON.
     - `/api/jobs`: GET list or POST submission.
     - `/api/jobs/:id`: GET one job.
   - Return `405 method_not_allowed` for wrong methods on recognized routes, optionally with `Allow`; return `404 not_found` for unknown paths and missing jobs.
   - List jobs by insertion sequence descending. Decode single-segment job IDs safely; malformed paths must not crash the handler.
   - Use one JSON response helper and a consistent error envelope. Include `fields` on every `invalid_request` response.
   - Determine worker health from a heartbeat no more than 3000 ms old.
   - Preserve the existing HTML resolution through `new URL('../ui/index.html', import.meta.url)`, which works from compiled `dist/server.js`.
   - Catch asynchronous request failures so malformed input or aborted uploads cannot create unhandled rejections. Unexpected failures receive a JSON server error when a response is still possible.
   - On SIGTERM/SIGINT, stop accepting connections, drain active requests with a bounded shutdown deadline, close remaining connections if necessary, and close SQLite.

5. **Implement sequential processing and durable retries.**
   - Write a heartbeat immediately at startup and refresh it every 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms. Atomically select and claim the oldest eligible queued job using insertion sequence and `available_at <= now`.
   - Starting a new attempt sets `running`, increments attempts, resets completed steps to zero, clears result/error, and updates `updatedAt`.
   - Wait approximately 100 ms for each step. If this is the first step and `attempts <= failAttempts`, fail before incrementing progress.
   - For a simulated failure with attempts below three, atomically return the same job to queued with zero progress, null result/error, and `available_at = now + 500 ms`.
   - At the third simulated failure, atomically mark failed with exactly `"transient failure"` and null result.
   - For successful steps, persist progress and `updatedAt` individually. On the last step, atomically publish completed status, full progress, and `input.toUpperCase()`.
   - Do not sleep while holding database locks. During a retry delay, other eligible jobs may run; choose the oldest eligible job each time.

6. **Recover interrupted work without losing retry accounting.**
   - Assume the specified single worker process; do not add a distributed worker coordination system.
   - At worker startup, recover persisted running work before claiming ordinary queued work. Replay the interrupted attempt from step zero while preserving its already-started attempt number. This recovery continues the durable attempt rather than allocating a fourth attempt after a crash during attempt three.
   - Reset progress atomically for replay, retain the running status, and apply the same first-step failure rule using the persisted attempt number.
   - Keep failure-to-queued and final completion transitions atomic, so a crash cannot leave half-published retry or result state.
   - Preserve queued jobs’ retry timestamps across restarts. Never select completed or failed jobs.
   - On SIGTERM/SIGINT, stop claiming work and exit after the current short sleep/database operation. Leave an interrupted job running for startup recovery, stop heartbeat updates, clear the heartbeat, and close SQLite.
   - A SIGKILL requires no cleanup: stale heartbeat expiry reports down, and persisted running state drives recovery on restart.

7. **Build the browser page against the API.**
   - Add all required `data-testid` attributes verbatim. Each `job-item` must have its public ID in `data-job-id` and contain its own status, progress, and result elements.
   - Use a text area for input, numeric controls initialized to 5 and 0, a submit button, and an initially empty `form-error` with `role="alert"`.
   - Use `novalidate` so browser constraint validation does not prevent API errors from reaching the page.
   - Send the input unchanged and numeric controls as JSON numbers. Do not silently replace invalid/empty numeric entries with defaults; send a value the API rejects, such as `null` for an empty control.
   - Clear the error region when a new submission starts and on success. On API rejection, show its message and every field name/message. Keep polling errors separate so refreshes do not erase submission errors.
   - Fetch jobs on page load, immediately after a successful submission, and every 500 ms. Serialize refreshes or discard stale responses to avoid older snapshots overwriting newer ones.
   - Render in API order with status text, `completed/total`, and output/error only when terminal. Use DOM creation and `textContent` for submitted strings and results.

## Behaviours to verify
- **Existing commands:** After implementation, run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. These checks cover examples, not the entire specification.
- **Startup and health:** Start each process first in separate trials with a fresh nested `DATABASE_PATH`. Confirm startup within 10 seconds, down without a worker, up while idle and busy, and down within about 3 seconds of worker SIGKILL.
- **Validation:** Exercise missing input, whitespace, Unicode length boundaries, unknown fields, multiple simultaneous errors, explicit nulls, numeric strings, fractions, out-of-range numbers, malformed JSON, non-object bodies, incorrect content types, and invalid keys. Verify `fields` and unchanged job count.
- **Idempotency:** Test omitted versus explicit defaults, changed values, unkeyed duplicates, simultaneous same-key requests, and replay after server restart. Verify one durable job per key and the correct 201/200/409 responses.
- **Processing:** Poll a 20-step job frequently enough to observe running progress. Verify one active job, oldest eligible pickup, step timing, exact preserved input, and JavaScript Unicode uppercase output.
- **Retries:** Test `failAttempts` 0 through 5. Expect attempts 1, 2, and 3 for eventual success with values 0, 1, and 2; values 3–5 must fail after exactly three attempts. Observe queued retry intervals and zero progress on failed attempts.
- **Durability:** Stop both processes gracefully and with SIGKILL, then restart using the same database. Check retained IDs, terminal states, idempotency records, and queued retry schedules. Kill the worker during a long attempt, including successful attempt three, and verify recovery without duplicate jobs or exceeding the attempt budget.
- **Routing and shutdown:** Check wrong methods on every known route, missing IDs, unknown paths, JSON content types/error envelopes, and clean SIGTERM exits for both processes.
- **Browser:** Inspect all required selectors, submit valid and invalid forms, confirm field names appear in the alert, and watch progress/terminal changes within 2 seconds. Reload to verify durable jobs reappear; submit HTML-like input to confirm it renders as text.

## Risks
- **Database contention:** Keep transactions short, configure the busy timeout before WAL, and initialize schema from both processes.
- **Ordering ties:** Millisecond timestamps can collide; use the insertion sequence for newest/oldest ordering.
- **Crash versus simulated failure:** A process interruption must not become an invented transient failure. Preserve the interrupted attempt number during recovery and enforce the three-attempt budget for simulated failures.
- **Inconsistent job shapes:** Use one serializer for create, replay, list, and detail responses, and publish terminal state atomically.
- **UI bypassing validation:** Avoid native form blocking, trimming input, coercing invalid numbers to defaults, or clearing API errors during background refresh.
- **Incomplete verification:** The supplied contract suite explicitly excludes restart persistence, browser behavior, and many validation cases; perform the additional checks above.