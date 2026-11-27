# Plan

## Approach
Extend the existing TypeScript entry points using only Node.js built-ins and retain all current commands. Put schema initialization, job serialization, and transactional state changes in a shared SQLite module used independently by the server and worker. Use short database transactions, asynchronous worker timers, durable retry deadlines, and a database heartbeat. Build the browser interface in the existing HTML file with API polling.

## Files
- `src/db.ts`: Extend database initialization; add schema, typed row conversion, queries, and transactional job operations.
- `src/jobs.ts`: Add public job/payload types and request validation helpers.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, progress, retries, heartbeat, restart recovery, and shutdown.
- `ui/index.html`: Implement the submission form, job list, error reporting, and polling.
- Leave all fixed files and `checks/` unchanged. Add no dependencies.

## Steps
1. **Define the shared data contract and schema.**
   - Preserve `openDatabase()`’s parent-directory creation and `busy_timeout` before WAL initialization. Both entry points must initialize the same schema with `CREATE TABLE IF NOT EXISTS`, so either process can start first.
   - Create a jobs table with an insertion sequence (`INTEGER PRIMARY KEY AUTOINCREMENT`), unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and retry eligibility timestamp in epoch milliseconds.
   - Use insertion sequence for deterministic ordering when jobs share a timestamp: descending for listing, ascending for processing.
   - Create a singleton heartbeat table storing the worker’s last-seen epoch milliseconds.
   - Add one serializer that exposes exactly the required job shape, excluding internal sequence, key, and retry deadline. Use `steps` for `progress.total` and expose output as `{ output }` only for completed jobs.
   - Use prepared statements and parameter binding throughout. Wrap multi-statement mutations in synchronous `BEGIN IMMEDIATE`/`COMMIT`, with rollback on exceptions; never hold a transaction across an `await`.

2. **Implement complete submission validation before any database mutation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or other media types with a `"body"` field error.
   - Read the request body, catch malformed/empty JSON, and reject null, arrays, and primitives with a `"body"` field error.
   - For objects, collect all offending fields, including every unknown own property.
   - Require string input with JavaScript `.length` between 1 and 1000 and nonempty `.trim()`. Preserve the original string exactly.
   - Apply numeric defaults only when properties are absent. Require actual numbers, `Number.isInteger`, and the specified ranges; reject numeric strings, null, and booleans.
   - Validate a present `Idempotency-Key` against the exact regex; an empty value is invalid, not an omitted key. Reject duplicate header values rather than silently choosing one.
   - Include header validation errors alongside body/field errors where ascertainable. Return `400 invalid_request` with a message and required `fields` array.

3. **Implement atomic creation and durable idempotency.**
   - Generate IDs with `randomUUID()` from `node:crypto`.
   - Inside one immediate transaction, look up a supplied key. Compare the stored immutable `input`, `steps`, and `failAttempts` against the validated payload after defaults.
   - Return the current original job with `200` for equal payloads or `409 idempotency_conflict` for differences.
   - Otherwise insert one queued job with zero attempts/progress, null output/error, and equal initial timestamps. Enforce uniqueness of non-null keys in SQLite; multiple null keys must remain allowed.
   - Capture the inserted queued representation before committing and return it with `201`. Do not re-read after committing, because the worker may already have changed the status.
   - Ensure invalid requests and conflicts insert nothing.

4. **Complete HTTP routing and lifecycle.**
   - Match paths before checking allowed methods: `/` permits GET, `/health` permits GET, `/api/jobs` permits GET/POST, and `/api/jobs/:id` permits GET.
   - Return JSON `405 method_not_allowed` for wrong methods on these paths, optionally with `Allow`; unmatched paths return JSON `404 not_found`. GET for an absent job also returns `404 not_found`.
   - Use URL pathname matching so query strings do not alter routes. Safely handle malformed URLs/encoded IDs without crashing.
   - Return lists newest first and individual jobs through the shared serializer.
   - `/health` returns `worker: "up"` only when a stored heartbeat is at most 3000 ms old; absent/stale heartbeat means `"down"`. The server must never write worker heartbeats.
   - Preserve serving `ui/index.html` through the existing module-relative path, which also works from `dist/server.js`.
   - Centralize JSON responses and structured errors, and catch asynchronous request-handler failures.
   - Retain `PORT` default 3000. On SIGTERM/SIGINT, stop accepting requests, allow active handlers to finish, then close SQLite. Bound shutdown of stalled connections so shutdown cannot hang indefinitely.

5. **Implement sequential worker processing and observable progress.**
   - Write a heartbeat immediately after initialization and every approximately 500 ms while idle, processing, or waiting between attempts.
   - Poll for eligible queued work every 100 ms. Select the oldest queued job whose persisted retry deadline has passed.
   - Claim it atomically: set running, increment attempts, reset progress to zero, clear result/error, and update its timestamp.
   - Execute only one job at a time. Await approximately 100 ms per step using asynchronous timers, then persist the completed-step count and update timestamp.
   - On a successful last step, atomically set completed progress, completed status, and `input.toUpperCase()` output. Use JavaScript uppercase conversion, not SQLite’s `upper()`.
   - Never select completed or failed jobs.

6. **Implement failures, delayed retries, and recovery.**
   - After the first step’s approximately 100 ms delay, if the current attempt number is at most `failAttempts`, fail before incrementing progress.
   - For attempts 1 and 2, atomically return the job to queued with zero progress, null result/error, and a retry deadline approximately 500 ms in the future.
   - On attempt 3 failure, atomically mark failed with exactly `"transient failure"`, null result, and zero progress. Never create a replacement job.
   - Persist retry deadlines so a worker restart does not erase the retry delay.
   - At worker startup, recover any running job before taking new queued work. Resume the interrupted logical attempt from step zero, preserving its already-incremented attempt number; apply the same failure rule to that attempt. This prevents a crash during attempt 3 from introducing attempt 4 or incorrectly failing a job that would succeed.
   - Persist the recovery progress reset and timestamp. Keep terminal rows untouched. With the specified single worker process, recovery can begin immediately without waiting for heartbeat expiration.
   - On SIGTERM/SIGINT, stop claiming work and finish or interrupt the current short timer. If interrupted, leave the running job recoverable; clear heartbeat/timers and close SQLite only after the loop stops. Abrupt termination relies on committed SQLite state and heartbeat expiration.

7. **Implement the browser page.**
   - Add every required `data-testid` exactly as specified, including `role="alert"` on `form-error`.
   - Initialize steps to 5 and fail attempts to 0. Preserve input text exactly; convert numeric field strings with `Number`, treating blanks as invalid values rather than accidentally converting an empty fail-attempt field to valid zero.
   - Use `novalidate` so native required/range validation does not prevent API validation and its field errors from reaching the alert.
   - POST JSON with the correct content type. Disable submit during the request and restore it in `finally`.
   - Clear prior errors for a new submission; show the API rejection message and every returned offending field name. Keep errors visible until another submission clears/replaces them; background polling must not clear them.
   - Fetch the list on load, immediately after successful submission, and approximately every 500 ms. Serialize list refreshes or guard responses against stale rendering.
   - Render newest first, with one `job-item` carrying `data-job-id` per job, status text, exact `completed/total` progress, and output/error only in the appropriate terminal state.
   - Render user input, results, and errors with DOM `textContent`, avoiding HTML interpolation. Keep polling after transient fetch failures.

8. **Build and verify the full contract.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.
   - The existing checks cover only startup and selected API examples. Exercise the additional cases below using temporary databases, separate server/worker processes, HTTP requests, and a browser.
   - Confirm the implementation diff changes only files under `src/` and `ui/`.

## Behaviours to verify
- **Independent startup and configuration:** Start worker-first, server-first, and simultaneously using a nested missing database directory and a nondefault port; both become ready within 10 seconds.
- **Health:** Start only the server and observe `"down"`; start the worker and observe `"up"`. Kill the worker and verify `"down"` after heartbeat expiration.
- **Validation:** Exercise malformed JSON, empty body, arrays/null/primitives, wrong/missing content type, unknown fields, missing/blank/oversized input, numeric strings, fractions, nulls, and range boundaries. Submit several errors together and verify every offending field appears and the job count stays unchanged.
- **Input preservation:** Submit whitespace-surrounded text and Unicode, including characters whose uppercase expands; verify stored input and JavaScript uppercase output exactly.
- **Routing:** Check unknown paths, missing IDs, and wrong methods on each known route; verify status codes, JSON content type, and error shape.
- **Idempotency:** Replay omitted versus explicit defaults, issue concurrent same-key requests, change each payload field, restart the server, then replay again. Verify one ID/row per key and independent jobs without keys.
- **Ordering and progress:** Queue several jobs while the worker is stopped, then start it. Verify oldest-first claims, newest-first listing, single-job execution, pickup within one second, and intermediate progress on a 20-step job.
- **Retries:** Test `failAttempts` 0, 1, 2, 3, and 5. Verify attempt counts 1, 2, 3, 3, and 3; queued delays within 250–2000 ms; zero failed-attempt progress; and the exact terminal error.
- **Durability:** Stop and restart both processes on the same database. Kill the worker during processing, during attempt 3 of a success-after-retries job, and while a retry is queued. Verify recovery, retained deadlines, unchanged job IDs, and no reprocessing of terminal jobs.
- **Shutdown:** Send SIGTERM to each actual Node process; verify prompt clean exit and no database-use-after-close errors.
- **Browser:** Submit valid and invalid forms, confirm numeric JSON values and visible field names, and watch status/progress/result update within two seconds without reload. Reload the page and verify durable jobs remain visible.

## Risks
- **SQLite contention and startup races:** Preserve busy-timeout-before-WAL ordering and keep write transactions short; never sleep while holding a transa
[truncated]