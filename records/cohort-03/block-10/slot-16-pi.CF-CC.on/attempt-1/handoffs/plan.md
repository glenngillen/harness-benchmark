# Plan

## Approach
Use the existing Node.js HTTP server and separate worker, with SQLite as their only shared state and communication channel. Centralize schema initialization, job serialization, and short transactional operations so either process can start first. Persist retry deadlines and worker heartbeats, and recover interrupted processing without touching terminal jobs. Build the browser page with plain HTML and JavaScript, polling the API every 500 ms.

## Files
- `src/db.ts`: Extend the existing database opener with shared schema initialization, transactions, prepared queries, and job serialization.
- `src/jobs.ts`: Add job/payload types, validation, and normalized payload comparison.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent submission, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat updates, sequential processing, durable retries, recovery, and shutdown.
- `ui/index.html`: Implement the submission form, validation feedback, and automatically refreshed job list.
- Leave all fixed files, commands, and `checks/` unchanged.

## Steps
1. **Define the durable schema and public representation.**
   - Preserve directory creation and the existing `busy_timeout` initialization before enabling WAL.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from both entry points.
   - Store jobs with an internal insertion sequence, unique public UUID, input, steps, fail-attempt count, status, attempts, completed steps, nullable output/error, ISO timestamps, and an internal retry-eligible timestamp.
   - Store a nullable unique idempotency key on the job. The immutable input, steps, and fail-attempt fields provide the normalized payload for comparison; multiple `NULL` keys must be allowed.
   - Add a singleton worker-heartbeat table containing a timestamp.
   - Use the insertion sequence for deterministic oldest/newest ordering, including submissions sharing the same millisecond.
   - Implement one serializer used by every job-returning endpoint. Exclude internal fields; expose `progress: { completed, total: steps }`, `result: { output }` only for completed jobs, and `error` only for failed jobs.
   - Use bound SQL parameters throughout. Transactions must be synchronous and short, with rollback on failure; never hold one across a sleep or HTTP body read.

2. **Implement validation before any submission mutation.**
   - Read the complete UTF-8 body and parse JSON with explicit handling for malformed or empty bodies.
   - Require media type `application/json`, case-insensitively, allowing parameters such as `charset=utf-8`. Missing or incompatible content type produces a `"body"` error.
   - Require a non-null, non-array JSON object. Reject every unknown own property and collect all independently detectable field errors.
   - Validate `input` as a string with JavaScript length 1–1000 and at least one non-whitespace character. Preserve its original contents.
   - Apply defaults only when properties are absent: `steps = 5`, `failAttempts = 0`. Explicit `null`, numeric strings, booleans, fractions, and out-of-range values fail validation.
   - Validate a present `Idempotency-Key` against the exact specified pattern; an empty header is invalid. Reject duplicate key headers rather than silently choosing one.
   - Return `400` with `error.code = "invalid_request"`, a message, and `fields` entries naming every offending field. Body-level failures use `"body"`; header failures use `"Idempotency-Key"`.
   - Ensure validation errors create neither jobs nor reserved keys.

3. **Implement HTTP routing and atomic submissions.**
   - Match the pathname separately from the method. Recognize `/`, `/health`, `/api/jobs`, and `/api/jobs/:id`; reject extra path segments.
   - Return JSON `404 not_found` for unknown routes and missing jobs. Return JSON `405 method_not_allowed` for unsupported methods on recognized routes, optionally with an `Allow` header.
   - Keep `/` as HTML using the existing module-relative `../ui/index.html` lookup, which works from `dist/server.js`.
   - Implement list/get endpoints using the shared serializer, with the list ordered by insertion sequence descending.
   - For submission, use `BEGIN IMMEDIATE`: look up the key if present, compare the three normalized payload values, then either return the original job, return a conflict, or insert a new queued job.
   - Keep the unique key constraint as database-level protection against concurrent submissions and restarts.
   - A new job has attempts/progress zero and null result/error. Capture its inserted queued representation inside the transaction and return it with `201`; do not reread after commit, since the worker might already have claimed it.
   - Return an existing job’s current representation with `200` for an identical replay, or `409 idempotency_conflict` for a different valid payload.
   - Implement `/health` using the persisted heartbeat: worker is up only when its last heartbeat is no more than 3 seconds old. The server must never update this heartbeat.
   - Route asynchronous handler errors through a common JSON error responder, avoiding unhandled promise rejections or duplicate responses.

4. **Implement the worker’s processing state machine.**
   - On startup, initialize the database and write a heartbeat immediately. Refresh it every 500 ms, including while processing or waiting for retries.
   - Poll for work every 100 ms when idle. Select the oldest eligible queued job; a job whose retry deadline is in the future must not prevent other eligible jobs from running.
   - Claim the selected job atomically: set `running`, increment attempts, reset completed steps to zero, clear result/error, and update `updatedAt`.
   - Process exactly one job at a time. Wait approximately 100 ms before each step.
   - On the first step, if the current attempt number is at most `failAttempts`, fail before recording any progress.
   - If this is attempt 1 or 2, persist `queued` with a retry deadline 500 ms in the future, zero progress, and null result/error.
   - If this is attempt 3, persist `failed`, error `"transient failure"`, null result, zero progress, and attempts 3.
   - Otherwise persist each completed step independently so readers can observe progress.
   - On the final step, atomically persist full progress, `completed`, output from JavaScript `input.toUpperCase()`, null error, and an updated timestamp.
   - Never select completed or failed jobs.

5. **Make restart and shutdown behavior explicit.**
   - Support the specified single-worker deployment. At worker startup, recover persisted `running` jobs before taking new queued work.
   - Treat recovery as restarting the interrupted logical attempt from step zero, retaining its already-recorded attempt number. This avoids double-counting an attempt that had started before the crash and allows an interrupted third attempt to finish without inventing a fourth retry.
   - Reapply the same first-step failure rule during recovery. A third attempt that should transiently fail must become failed; an interrupted successful third attempt must finish.
   - Preserve queued retry deadlines across restarts. Recovery starts immediately, well inside the restart allowance.
   - On worker `SIGTERM`/`SIGINT`, stop taking work and interrupt short waits. Leave unfinished processing durably marked running for recovery, stop heartbeat updates, clear the heartbeat, and close SQLite.
   - On server shutdown, stop accepting connections, finish active requests with a bounded shutdown period, close remaining connections if necessary, then close SQLite.
   - Do not erase jobs or reinitialize heartbeat state when the server starts. A killed worker’s heartbeat naturally expires after 3 seconds.

6. **Build the browser UI around the actual API contract.**
   - Add every required `data-testid`, including a persistent, initially empty `form-error` region with `role="alert"`.
   - Use defaults 5 and 0 for the numeric fields. Send their values as numbers; do not use `parseInt`, which would silently truncate invalid fractional input.
   - Use `novalidate` so browser constraint validation does not suppress API validation feedback. Convert empty/invalid numeric entries to a value the API rejects, such as `null`, rather than accidentally interpreting an empty fail-attempt field as zero.
   - Submit JSON to `/api/jobs`. Clear prior errors when starting a submission and after success; for API rejection, display the error message and every returned field name/message.
   - Fetch the list on load, after successful submission, and every 500 ms. Prevent overlapping list fetches or discard stale responses so older snapshots cannot overwrite newer state.
   - Render one `job-item` with `data-job-id` per job, newest first. Include status, exact `completed/total` text, and result/error text according to status.
   - Insert user input, outputs, and error text using `textContent`, never interpolated HTML.
   - Keep the form intact during list updates and recover polling after temporary fetch failures.

7. **Build and verify without changing the fixed checks.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with local HTTP scripts and browser inspection for the cases below. Use isolated temporary database paths and cleanly stop spawned processes.
   - Keep any added verification source under `src/` if committed; do not modify package scripts or `checks/`.

## Behaviours to verify
- **Startup and configuration:** Start each process first in separate runs, including simultaneous startup with a nonexistent database parent directory. Confirm readiness within 10 seconds and that custom `PORT`/`DATABASE_PATH` work.
- **Validation:** Submit malformed JSON, arrays, null, missing content type, unknown fields, whitespace-only input, length boundaries, Unicode input, numeric strings, fractions, null numeric values, and invalid keys. Check all offending fields and unchanged job count.
- **Idempotency:** Replay omitted versus explicit defaults, change each payload field, send concurrent requests with one key, and replay after server restart. Confirm one job and correct `201`/`200`/`409` responses. No-key duplicates must create separate jobs.
- **Routing and representation:** Exercise every endpoint, unknown routes, and wrong methods. Check JSON error shapes, nullability, timestamps, deterministic list order, and exact input preservation.
- **Progress and pickup:** Poll a 20-step job frequently; confirm pickup within 1 second, visible intermediate progress, roughly 100 ms steps, and final JavaScript uppercase output.
- **Retries:** Exercise `failAttempts` 0 through 5. Verify attempts 1/2/3 as appropriate, queued retry intervals of at least 250 ms, no progress on simulated failure, exact terminal error, and no duplicate jobs.
- **Durability:** Kill the actual worker process during running work and during retry waits; restart with the same database. Repeat with both processes stopped, and with SIGTERM. Confirm recovery, persisted keys/deadlines, unchanged terminal jobs, and interrupted third-attempt behavior.
- **Health:** Check down before worker startup, up while idle/processing/retrying, and down within roughly 3 seconds after SIGKILL.
- **UI:** Submit valid and invalid forms; verify required test IDs, field names in alerts, updates within 2 seconds, exact progress formatting, final output/error, newest-first order, and safe display of HTML-like input.

## Risks
- **Concurrent SQLite startup or writes:** Preserve busy-timeout-before-WAL ordering and keep write transactions short. Do not sleep inside transactions.
- **Creation response races:** Return the queued snapshot captured during insertion; a post-commit read could incorrectly return a running job with `201`.
- **Recovery consuming retry budget twice:** Keep recovery distinct from starting a new retry, especially when
[truncated]