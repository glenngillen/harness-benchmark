# Plan

## Approach
Implement the API and worker as separate Node.js processes sharing a SQLite database, using only built-ins. Keep the existing entry points, commands, TypeScript configuration, and UI location. Persist jobs, idempotency keys, retry deadlines, and worker heartbeat in SQLite; use short transactions for state transitions and asynchronous timers for processing. Build a dependency-free browser page that submits jobs and polls their state.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactional submission and claiming, job serialization, heartbeat, and recovery operations.
- `src/jobs.ts`: Add job/payload types and pure request validation and normalization helpers.
- `src/server.ts`: Replace the placeholder routes with the HTTP API, UI serving, structured errors, request parsing, and graceful shutdown.
- `src/worker.ts`: Replace the idle loop with sequential processing, persisted retries, heartbeat, restart recovery, and graceful shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, and polling script.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the public model and validation.**
   - Define the exact public job shape separately from database rows.
   - Validate parsed JSON as `unknown`: reject `null`, arrays, primitives, unknown properties, missing input, and every invalid supplied field.
   - Validate input using JavaScript `.length` and `.trim()` without modifying the stored string.
   - Require actual numbers and `Number.isInteger()` for numeric fields. Apply defaults only when the field is absent; reject explicit `null`.
   - Collect all detectable field errors, including unknown properties. Use `"body"` for malformed JSON, invalid body shape, or missing/non-JSON content type.
   - Validate a supplied `Idempotency-Key` against the exact required regex; reject empty or duplicate headers rather than treating them as absent.
   - Normalize valid payloads to `{ input, steps, failAttempts }` in a fixed property order for deterministic comparison.

2. **Initialize durable storage from either process.**
   - Preserve parent-directory creation and set `busy_timeout` before enabling WAL, as the starter already does. Use durable SQLite synchronization settings.
   - Create tables and indexes with `IF NOT EXISTS`, so either process can initialize the database first.
   - Store jobs with:
     - An integer insertion sequence for deterministic ordering and a unique public UUID.
     - Input, steps, fail-attempt count, status, attempts, completed steps, output, error, and ISO timestamps.
     - A nullable unique idempotency key and normalized payload string.
     - A numeric `available_at` timestamp for persisted retry eligibility.
   - Store worker heartbeat in a singleton database row, using epoch milliseconds.
   - Centralize row-to-job serialization: expose only specified fields, derive `progress.total` from `steps`, and return explicit `null` for unavailable result/error.
   - Use parameterized statements throughout. Wrap multi-statement writes in `BEGIN IMMEDIATE` / `COMMIT`, rolling back on exceptions; never hold a transaction across an `await`.

3. **Implement atomic submissions and reads.**
   - Generate IDs with `crypto.randomUUID()`.
   - In one transaction, check any idempotency key before insertion. Return the existing job for matching normalized payloads, or a conflict for differing payloads.
   - Keep the unique key constraint as a database-level safeguard against concurrent submissions.
   - New jobs start queued with attempts/progress zero, null result/error, and equal creation/update timestamps.
   - Capture the inserted queued representation inside the transaction and return that snapshot for `201`; a worker could claim the job immediately after commit.
   - List jobs by insertion sequence descending. Fetch individual jobs by their public ID. Replays return the original job’s current state.

4. **Implement HTTP routing and lifecycle.**
   - Retain HTML loading via `new URL('../ui/index.html', import.meta.url)`, which also works from `dist/server.js`.
   - Match known paths before dispatching methods:
     - `/`: GET HTML.
     - `/health`: GET JSON.
     - `/api/jobs`: GET list or POST submission.
     - `/api/jobs/:id`: GET individual job.
   - Return `405 method_not_allowed` for unsupported methods on these paths, and `404 not_found` for unknown paths or missing jobs. Optionally include the appropriate `Allow` header.
   - Parse the URL safely; handle invalid encoded IDs without crashing.
   - For POST, collect bytes and decode UTF-8 once before JSON parsing. Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`.
   - Complete validation before database mutation. Return the exact structured error envelope, including `fields` for every `invalid_request`.
   - Give every API response and routing error a JSON content type. Catch asynchronous handler failures so one bad request cannot terminate the server.
   - `/health` reports up only when the stored heartbeat is no more than 3 seconds old.
   - Honor `PORT`, defaulting to 3000. On SIGTERM/SIGINT, stop accepting connections, finish active handlers, bound connection draining, then close SQLite.

5. **Implement sequential processing and persisted retries.**
   - On startup, initialize storage and recover abandoned running jobs to queued, clearing partial progress/result/error while retaining input, identity, creation time, and attempt history. Recovery belongs to the worker, never server startup.
   - For the specified single-worker deployment, perform recovery immediately before the processing loop.
   - Write heartbeat immediately and then every approximately 500 ms, including while processing and waiting for retries.
   - Poll eligible queued work every 100 ms. In a short transaction, select the oldest job with `available_at <= now`, mark it running, increment attempts, reset progress to zero, clear result/error, and update its timestamp.
   - Process only one job at a time. Sleep approximately 100 ms before each step.
   - At the first step, if the persisted attempt number is at most `failAttempts`, fail before recording any progress:
     - Below attempt 3, return the same job to queued with `available_at = now + 500 ms`, zero progress, and null public result/error.
     - At attempt 3, mark failed with exactly `"transient failure"` and null result.
   - Otherwise, persist each finished step and its updated timestamp. Commit the final step and completed status/output together; compute output using JavaScript `input.toUpperCase()`.
   - Do not reset attempts on restart or retry, select terminal jobs, or create a separate result/job during processing.
   - Treat crash recovery separately from simulated failure: a recovered run starts another counted attempt, but an interrupted otherwise-successful run must not become a fabricated transient failure merely because its attempt count reached three.
   - On shutdown, stop claiming jobs, clear heartbeat scheduling, and stop processing at an await boundary. Leave unfinished work recoverable, invalidate heartbeat, and close SQLite after pending callbacks are finished.

6. **Build the browser page.**
   - Add the required `data-testid` attributes exactly, including `data-job-id` on each job item and `role="alert"` on `form-error`.
   - Use a textarea for input, fields initialized to 5 and 0 for numeric settings, and a submit button inside `job-form`.
   - Disable native form validation with `novalidate` so API rejection messages reach the required alert region.
   - Preserve input exactly. Convert nonempty numeric field values to numbers; send invalid/empty numeric entries in a form the API rejects rather than silently applying defaults or converting an empty field to zero.
   - Submit JSON to `/api/jobs`; omit idempotency keys for normal UI submissions.
   - Clear prior submission errors when submitting and after success. On API rejection, show its message and every offending field name; keep that error visible through background polls.
   - Fetch the list immediately on page load, after successful submission, and every approximately 500 ms. Avoid overlapping polls or stale responses overwriting newer state.
   - Render in API order with exact status, `completed/total`, and completed output or failed error. Keep result text empty otherwise.
   - Use DOM creation and `textContent` for user-controlled strings.

7. **Build and validate the completed implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Use temporary database paths for additional local HTTP/process scenarios and inspect the page in a browser.
   - The supplied checks cover only part of the task; explicitly exercise restart, UI, concurrency, and validation boundaries below.

## Behaviours to verify
- **Startup and configuration:** Start server first, worker first, and both together with a database in a nonexistent parent directory. Confirm startup within 10 seconds and default/custom ports.
- **Health:** Confirm down with no worker, up while idle or processing, and down within 3 seconds after SIGKILL.
- **Job representation:** Check exact keys, defaults, nulls, ISO timestamps, preserved whitespace, and Unicode uppercase behavior.
- **Validation:** Exercise malformed/empty JSON, arrays/null, missing or wrong content type, unknown fields, numeric strings, fractions, boundary violations, whitespace-only input, and invalid keys. Combine several invalid fields and confirm all appear without creating jobs.
- **Routing:** Check unknown paths, missing IDs, and wrong methods on every known route; verify JSON error envelopes and content types.
- **Idempotency:** Submit matching/default-equivalent and conflicting payloads, including concurrent requests. Repeat after server restart; confirm one job and the same ID. Unkeyed repetitions must create separate jobs.
- **Ordering and processing:** Queue several jobs before starting the worker; verify newest-first listing and oldest-first processing. Poll a 20-step job frequently enough to observe intermediate progress and only one running job.
- **Retries:** Verify `failAttempts` 0, 1, and 2 complete on attempts 1, 2, and 3; values 3–5 fail on attempt 3 with exact error text. Observe queued retry intervals and zero progress on failed attempts.
- **Durability:** SIGTERM and SIGKILL the worker during processing and retry waits, then restart against the same database. Confirm recovery within the required window, persisted retry timing, unchanged IDs, and no reprocessing of terminal jobs. Restart both processes and verify persisted idempotency.
- **Browser:** Submit valid and invalid values, verify all required selectors and field names in errors, and observe progress/result updates within 2 seconds without reload. Reload the page and confirm durable jobs remain visible.
- **Shutdown:** Send SIGTERM to each process and confirm prompt exit without open timers or connection hangs.

## Risks
- SQLite startup and write contention can crash either process: retain busy timeout, initialize schema idempotently, and keep transactions short.
- Selecting and updating separately can cause duplicate claims or idempotent inserts: make both operations transactional and retain uniqueness constraints.
- A delayed retry must survive restart: persist its deadline rather than relying solely on an in-memory timeout.
- Crash-interrupted attempts are distinct from simulated failures; the brief does not explicitly resolve repeated crashes around the third attempt. Preserve truthful attempt counts and ensure recovery never strands a running job or invents a transient failure.
- Immediate recovery assumes the specified single worker. Supporting overlapping worker processes would additionally require ownership/leases before reclaiming running jobs.
- Native browser validation, numeric coercion, stale polling responses, or unsafe HTML interpolation can violate the UI contract despite a correct API; explicitly check those cases.