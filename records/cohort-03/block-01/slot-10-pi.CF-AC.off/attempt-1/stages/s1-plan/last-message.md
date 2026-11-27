# Plan

## Approach
Implement the API and worker as separate Node.js processes sharing a SQLite database, with no direct communication between them. Extend the existing database helper to initialize durable job state and a worker heartbeat, and keep transactions short so polling and progress updates remain responsive. Use a sequential worker loop with persisted retry deadlines and explicit recovery of interrupted work. Serve a dependency-free HTML page that submits jobs and polls the API.

## Files
- `src/db.ts`: Extend database initialization; add schema, typed row mapping, transactional submission, job queries, worker transitions, and heartbeat operations.
- `src/jobs.ts`: Add shared job/payload types, validation, normalized payload comparison, and API error types.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health, HTML serving, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, sequential processing, progress updates, retries, restart recovery, and graceful shutdown.
- `ui/index.html`: Implement the form, accessible error region, job list, and polling script.
- Leave all fixed files and `checks/` unchanged. Preserve existing commands and TypeScript `.ts` import conventions.

## Steps
1. **Define the shared model and database schema.**
   - Keep `openDatabase()` creating the parent directory and setting `busy_timeout` before WAL mode.
   - Initialize the same schema from either process using `CREATE TABLE IF NOT EXISTS`, so either can start first.
   - Store jobs with:
     - An internal integer insertion sequence for deterministic ordering.
     - Unique public ID generated with `randomUUID()`.
     - `status`, exact `input`, `steps`, `fail_attempts`, `attempts`, completed-step count, nullable output and error, and ISO creation/update timestamps.
     - Nullable unique idempotency key.
     - A persisted numeric `available_at` timestamp for retry eligibility.
   - Store worker heartbeat time in a separate singleton table. Opening the database from the server must not refresh this heartbeat.
   - Add an index supporting selection of eligible queued jobs.
   - Use prepared statements and bound parameters throughout.
   - Provide one row-to-job mapper that emits exactly the required public shape, including explicit nulls, nested progress, and no internal database fields.
   - Order lists by insertion sequence descending and queued selection by sequence ascending; timestamps alone cannot resolve simultaneous inserts reliably.

2. **Implement validation before any mutation.**
   - Read and concatenate request bytes before UTF-8 decoding and JSON parsing.
   - Require the media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Report missing or incorrect content type as field `body`.
   - Reject malformed JSON, empty bodies, null, arrays, and primitive roots with field `body`.
   - For object bodies, collect all offending fields rather than stopping at the first:
     - Unknown own property names.
     - Missing or invalid `input`; use JavaScript `.length` and `.trim()` only to validate, never to alter the stored input.
     - Wrong types, nonintegers, and out-of-range numeric fields.
   - Apply defaults only to absent properties; explicit `null` is invalid.
   - Validate a present `Idempotency-Key` against the exact required expression and report failures under `Idempotency-Key`. Reject ambiguous multiple header values rather than silently picking one.
   - Aggregate header and body-field errors when possible. Return `400` with `error.code`, a useful message, and required `fields`.
   - Construct normalized payloads in a fixed field order: `input`, `steps`, `failAttempts`.

3. **Make submission and idempotency atomic.**
   - Use a short `BEGIN IMMEDIATE` transaction around key lookup and insertion; always roll back on failure.
   - If a key exists, compare its job’s immutable input, steps, and fail-attempt count with the normalized request:
     - Equal: return the original job’s current representation with `200`.
     - Different: return `409 idempotency_conflict`.
   - Otherwise insert one queued job with attempts/progress zero, null result/error, and equal creation/update timestamps.
   - Enforce uniqueness in SQLite as well as in application logic.
   - Capture the inserted queued representation within the transaction, commit, and return it with `201`. Do not reread after committing: the worker could already have changed its status.
   - Requests without keys always insert distinct jobs. Validation errors and conflicts insert nothing.

4. **Complete HTTP routing and lifecycle.**
   - Route by URL pathname, ignoring query strings.
   - Implement:
     - `GET /`: existing HTML file, resolved relative to `import.meta.url`; this path already works from `dist/server.js`.
     - `GET /health`: `status: "ok"` and worker `"up"` only when its persisted heartbeat is no more than 3 seconds old.
     - `POST /api/jobs`: validated submission.
     - `GET /api/jobs`: mapped jobs newest first.
     - `GET /api/jobs/:id`: mapped job or `404 not_found`.
   - Match a detail route only for one nonempty ID segment. Handle malformed path encoding without crashing.
   - For a recognized path with an unsupported method, return `405 method_not_allowed`; for an unknown path, return `404 not_found`. Include an appropriate `Allow` header for 405 responses.
   - Centralize JSON responses and the required error envelope. Serve HTML only for the page.
   - Catch asynchronous request-handler errors so malformed requests or database errors do not terminate the server; unexpected errors receive a generic JSON `500`.
   - Retain `PORT` default `3000` and `DATABASE_PATH` default `data/jobs.db`.
   - On SIGTERM/SIGINT, stop accepting connections, allow active handlers a bounded time to finish, close lingering connections if necessary, and close SQLite only after handlers stop using it.

5. **Implement sequential worker processing.**
   - Write a heartbeat immediately after initialization and every 500 ms while idle, processing, or waiting for retries.
   - Poll for work every 100 ms. In a short transaction, select the oldest eligible queued job and set it to running, increment attempts, reset progress to zero, clear result/error, and update its timestamp.
   - Commit before waiting or processing; never hold a write transaction across a timer.
   - For each step, await approximately 100 ms.
   - At the first step, if the current attempt number is at most `failAttempts`, fail before incrementing progress:
     - Attempts 1–2: set status queued, progress zero, null result/error, and `available_at = now + 500 ms`.
     - Attempt 3: set status failed, progress zero, null result, and error exactly `"transient failure"`.
   - Persist successful step progress and `updatedAt` after every step.
   - On the last successful step, atomically set completed progress, completed status, and output using JavaScript `input.toUpperCase()`.
   - Exclude retries whose deadline has not arrived; allow other eligible queued jobs to run while they wait.
   - Never select completed or failed jobs.

6. **Handle restarts and shutdown explicitly.**
   - Treat a durable running row as an interrupted logical attempt when the sole worker restarts. Process it again from step zero before selecting fresh work, keeping its recorded attempt number.
   - Reset its partial progress and refresh `updatedAt` before replaying its steps. Apply the same transient-failure decision using that recorded attempt number.
   - This resumes the already-started attempt rather than creating a fourth attempt after a crash during attempt three. Increment attempts only when claiming a queued job for a new attempt.
   - Persisted retry deadlines remain authoritative after restart; do not restart retry delays or reset attempt counts.
   - On SIGTERM/SIGINT, stop claiming jobs and finish the current bounded attempt, including its final completed/queued/failed transition. Keep heartbeating until processing stops, then clear the heartbeat, cancel timers, and close SQLite.
   - After SIGKILL, the running row remains recoverable and heartbeat freshness naturally expires. No server startup action should reset running jobs.
   - Scope this recovery policy to the requested single worker process; do not introduce unnecessary multi-worker lease machinery.

7. **Build the browser page.**
   - Add every required `data-testid`, with `data-job-id` on each job item and `role="alert"` on the form-error region.
   - Provide defaults of `5` and `0` for steps and fail attempts.
   - Use `novalidate` so browser constraints do not prevent API validation from returning field-specific errors.
   - Submit exact input text and numeric conversions of nonempty numeric fields as JSON. Represent empty numeric fields as invalid values rather than accidentally converting them to zero.
   - Clear the error region when a new submission starts and after success. On API rejection, display the rejection message and each returned field name/message.
   - Disable the submit button while its request is pending and restore it in `finally`.
   - Load the list immediately and poll every 500 ms using a loop that avoids overlapping fetches. Refresh promptly after successful submission.
   - Render newest-first items with exact status text, `completed/total`, completed output, failed error, or an empty result region as appropriate.
   - Use DOM creation and `textContent`, never interpolate submitted input or output into HTML.
   - Keep polling failures separate from submission validation errors, and continue polling after temporary network failures.

## Behaviours to verify
- **Existing commands:** Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`. The disclosed checks do not cover the entire task.
- **Startup order:** With a fresh database in a missing parent directory, start worker first, server first, and both together. Confirm startup within 10 seconds and no schema/WAL lock failures.
- **Health:** Server alone reports down; a worker reports up while idle and busy. After SIGKILL, health changes to down once the last heartbeat exceeds 3 seconds.
- **Validation:** Exercise malformed JSON, nonobject bodies, missing/non-JSON content type, unknown properties, numeric strings, nulls, fractions, range boundaries, whitespace-only input, and invalid keys. Submit several invalid fields together and verify all names appear and the job count is unchanged.
- **String semantics:** Preserve leading/trailing whitespace and use JavaScript UTF-16 length and uppercase behavior, including non-ASCII input.
- **Idempotency:** Compare omitted defaults against explicit defaults, retry after completion and after restarting the server, submit conflicting payloads, and send concurrent requests with the same key. Confirm exactly one durable job.
- **Routing:** Check wrong methods on every recognized route, nonexistent IDs, unknown paths, and malformed encoded paths; verify JSON error envelopes.
- **Processing:** Poll a 20-step job frequently enough to observe intermediate progress. Confirm idle pickup within 1 second, approximately 100 ms per step, and only one running job.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Expect completion on attempts 1, 2, and 3 respectively, then terminal failure at attempt 3 for the last two cases. Observe queued retry intervals and zero progress on simulated failures.
- **Durability:** Stop/restart both processes with the same database using SIGTERM and SIGKILL. Kill the worker during progress, during retry waiting, and during the third attempt; verify recovery without losing jobs, exceeding the retry cap, or reprocessing terminal jobs.
- **Browser:** Submit valid and invalid values, verify all selectors and alert content, observe status/progress changes within 2 seconds, reload to recover persisted jobs, and confirm HTML-like input displays as literal text.
- **Shutdown:** Signal the actual server/worker processes and verify timely exit without unhandled errors, dangling timers, or lost committed state.

## Risks
- **SQLite races:** Preserve busy timeout before WAL setup, initialize schema from both processes, enforce unique keys in SQLite, and keep transactions short.
- **Incorrect retry accounting:** Distinguish starting a new queued attempt from replaying an interrupted running attempt; never reset durable attempt counts or allow a fourth transient retry.
- **Stale progress or partial terminal state:** Update progress and terminal result/status atomically on the final step, and clear result/error when starting an attempt.
- **Validation coercion:** Validate types before range checks; apply defaults only when absent and normalize only after validation.
- **UI bypassing API errors:** Disable native validation, send numeric values deliberately, and include every offending field name in the alert.
- **False confidence from supplied checks:** Passing smoke and contract checks is necessary but insufficient; explicitly exercise restart, timing, routing, and browser behavior.