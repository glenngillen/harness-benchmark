# Plan

## Approach
Use Node.js built-ins and the existing server, worker, and UI entry points. Initialize the same SQLite schema from either process, with durable jobs, idempotency keys, retry scheduling, and worker heartbeat state. Keep database transactions short; the worker waits asynchronously between steps and commits each progress update. Serve a small browser page that submits through the API and polls for job changes.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, prepared queries, transactions, and job serialization.
- `src/jobs.ts` (new): Define job/payload types, submission validation, and normalized payload comparison.
- `src/server.ts`: Implement API routes, JSON errors, request parsing, health reporting, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, persisted retries, interrupted-job recovery, and shutdown.
- `ui/index.html`: Add the submission form, error region, job list, styles, and browser JavaScript.
- Leave all fixed files and `checks/` unchanged; add no dependencies.

## Steps
1. **Establish shared storage.**
   - Retain parent-directory creation and `busy_timeout` before WAL setup in `openDatabase`.
   - Run idempotent `CREATE TABLE IF NOT EXISTS` statements from both processes.
   - Store jobs with an integer insertion sequence, unique server-generated UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, normalized payload, and retry eligibility timestamp.
   - Use the insertion sequence for deterministic oldest/newest ordering, including jobs created in the same millisecond.
   - Add a singleton worker-heartbeat row storing a timestamp in milliseconds.
   - Centralize conversion from SQLite rows to the exact public job shape. Exclude internal scheduling/key fields; derive `progress.total` from `steps`, expose output only for completed jobs and error only for failed jobs.
   - Use parameterized statements and a transaction helper that always rolls back on errors. Never hold a transaction across an `await`.

2. **Implement validation before database mutation.**
   - Accept `application/json` case-insensitively with optional parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Collect request bytes, decode UTF-8 once, and parse JSON with handled errors. Reject empty/malformed JSON, arrays, `null`, and primitives as `"body"` errors.
   - Inspect own keys and report each unknown field. Validate all known fields without numeric coercion.
   - Require `input` to be a string of JavaScript length 1–1000 whose trimmed value is nonempty; preserve the original string.
   - Apply defaults only when `steps` or `failAttempts` is absent, never when explicitly `null`. Require integers in the specified ranges.
   - Validate a present `Idempotency-Key` against the full required expression, including rejecting empty or duplicate header values. Name its error field `"Idempotency-Key"`.
   - Return all detectable offending fields together in `400 invalid_request`; do not stop after the first field error. For an unparseable body, still include an independently invalid idempotency header.
   - Normalize valid payloads into a fixed-key-order representation of `{input, steps, failAttempts}`.

3. **Implement atomic submissions and job reads.**
   - For `POST /api/jobs`, begin an immediate transaction after validation. If a supplied key exists, compare normalized payloads and return either the original job with `200` or `409 idempotency_conflict`.
   - Otherwise generate an ID with `crypto.randomUUID()` and insert the queued job with attempts/progress zero, null output/error, and matching creation/update timestamps.
   - Read the inserted row within the transaction and retain that snapshot for the `201` response, ensuring it reports `queued` even if the worker claims it immediately afterward.
   - Enforce key uniqueness in SQLite as well as in application logic. Commit the key and job together so concurrent requests and server restarts cannot create duplicates.
   - Implement list ordering by descending insertion sequence and individual lookup by ID. Requests without keys always insert new rows.

4. **Complete routing and server lifecycle.**
   - Classify known paths before checking methods: `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment.
   - Serve HTML for `GET /`; use the existing `new URL('../ui/index.html', import.meta.url)` approach, which works from `dist/server.js`.
   - Return JSON `404 not_found` for unknown paths or missing jobs, and JSON `405 method_not_allowed` for unsupported methods on known routes. Include an appropriate `Allow` header.
   - Give every API/error response the required envelope and `application/json` content type. Catch asynchronous handler failures so requests cannot crash the server or hang.
   - Compute worker health from the persisted heartbeat: up only when its age is at most 3000 ms. Server startup must not overwrite heartbeat state.
   - Respect `PORT`, defaulting to 3000. Retain the server handle, stop accepting connections on SIGTERM/SIGINT, close idle connections, finish active work within a bounded grace period, and then close SQLite.

5. **Implement the worker state machine.**
   - Open/initialize SQLite independently of the server. Write an initial heartbeat and refresh it every approximately 500 ms, including while idle, processing, and waiting for retries.
   - Poll for work every approximately 100 ms. In a short transaction, select the oldest queued job whose eligibility time has arrived, then mark it running, increment attempts, reset progress to zero, clear output/error, and update its timestamp.
   - Process one job at a time. Wait approximately 100 ms before each step; commit each completed step separately so API reads observe intermediate progress.
   - On an attempt whose number is at most `failAttempts`, fail after the first step’s delay but before recording any progress.
   - For transient failures on attempts 1 or 2, atomically return the job to queued with a persisted eligibility time approximately 500 ms later, zero progress, and null result/error. The worker may process other eligible jobs while that job waits.
   - On the third transient failure, atomically set failed, attempts 3, progress zero, null output, and error `"transient failure"`.
   - On a successful last step, atomically write the final progress, completed status, and `input.toUpperCase()` output. This avoids a crash gap between final progress and completion.
   - Update `updatedAt` on every job mutation while preserving `createdAt`.

6. **Handle restart and shutdown explicitly.**
   - Before claiming queued work, recover any running job left by the previous worker. Under the specified single-worker model, startup can identify this directly without waiting for a lease expiry.
   - Replay the interrupted attempt from step zero using its already-persisted attempt number; treat this as recovery of that unfinished attempt, not a new transient-failure retry. This preserves the three-attempt limit even if the worker dies during attempt 3.
   - Apply the same failure test and completion logic during recovery. Only an actual transition from queued to a new attempt increments attempts.
   - Preserve queued retry deadlines across restarts. Never reset or select completed/failed jobs for processing.
   - On SIGTERM/SIGINT, stop claiming work, cancel or finish the short pending step wait, stop heartbeat updates, clear the heartbeat, and close the database. Leave unfinished running work durable for restart recovery.
   - SIGKILL requires no cleanup: the heartbeat naturally expires, committed progress survives, and startup recovery handles unfinished work.

7. **Build the browser page.**
   - Add every required `data-testid`, including `form-error` with `role="alert"` and each `job-item` with `data-job-id`.
   - Use a textarea for input and numeric fields initially containing `5` and `0`. Use `novalidate` on the form so browser constraints do not hide API validation responses.
   - Submit input unchanged and numeric field values as numbers. Treat blank or invalid numeric text as an invalid value such as `null`, rather than accidentally converting blank input to zero or silently applying defaults.
   - Clear the error region for a new submission and after success. On API rejection, show the error message and every returned field name/message.
   - Fetch the list immediately and refresh approximately every 500 ms using a non-overlapping polling loop; refresh after successful submission.
   - Render newest first, status text, `completed/total`, and output/error according to status. Use DOM APIs and `textContent` for submitted input and output.
   - Keep the previous list visible after a temporary polling failure, and continue polling. Keep network failures distinct from successful empty responses.

## Behaviours to verify
- **Existing commands and compilation:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The supplied checks cover only part of the requirements.
- **Startup independence:** Use a fresh nested `DATABASE_PATH`; start worker first, server first, and both together. Confirm startup within 10 seconds and automatic parent-directory creation.
- **Validation:** Exercise malformed JSON, missing/wrong content type, non-object bodies, unknown fields, nulls, numeric strings, fractions, boundaries, whitespace-only input, and invalid keys. Submit several bad fields together; verify every field is named and job count is unchanged.
- **Exact input handling:** Submit surrounding whitespace and Unicode, including characters whose uppercase output changes length. Confirm stored input remains exact and output matches JavaScript `toUpperCase()`.
- **Idempotency:** Compare omitted defaults with explicit defaults; issue concurrent same-key requests; test conflicts, restart the server, and replay again. Verify one durable job per key and new jobs for keyless submissions.
- **Processing and retries:** Poll a 20-step job frequently to observe running state and intermediate progress. Test `failAttempts` 0 through 5; verify success on attempts 1–3 or failure at exactly 3, queued retry delays, and no duplicate jobs.
- **Ordering:** Queue several jobs with the worker stopped, then start it. Verify oldest eligible jobs run first and listing remains newest first.
- **Health:** Check up while idle and active; SIGKILL the worker and confirm down after the three-second freshness window, then up after restart.
- **Durability:** Restart both processes against the same file after graceful stops and SIGKILL. Kill the worker mid-attempt, including attempt 3, and during retry waiting. Confirm recovery within the specified bound and unchanged terminal jobs.
- **HTTP routing:** Check all documented methods, unsupported methods on known paths, unknown paths, missing IDs, JSON error envelopes, and content types.
- **Browser contract:** Inspect all test IDs, submit valid and invalid jobs, verify field names in alerts, observe progress/results without reload within two seconds, and confirm HTML-like input displays as text.
- **Shutdown:** Signal the actual Node processes, including during idle and processing states; verify prompt exit, released database handles, and restartability.

## Risks
- **SQLite races and locks:** Keep WAL and busy timeout configuration, atomic keyed insertion, transactional claims, and short writes. Do not sleep inside transactions.
- **Restart semantics:** Distinguish replaying an interrupted attempt from starting a retry; otherwise crashes can consume or exceed the three-attempt budget.
- **Heartbeat staleness:** Refresh independently of job progress so idle workers and retry waits remain healthy; never infer liveness from run
[truncated]