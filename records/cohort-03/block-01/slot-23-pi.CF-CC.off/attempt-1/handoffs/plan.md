# Plan

## Approach
Implement the API and worker as separate Node.js processes using the existing SQLite helper and commands. SQLite will hold jobs, idempotency keys, retry deadlines, and worker heartbeat state; neither process will depend on the other being started first. Use short transactions for submissions and worker transitions, with asynchronous timers between processing steps. Serve a dependency-free browser page that submits to the API and polls for updates.

## Files
- `src/db.ts`: Extend database initialization with schema creation, prepared queries, transaction helpers, and job serialization.
- `src/jobs.ts`: Add shared job types, payload validation, normalization, and error types.
- `src/server.ts`: Replace placeholder responses with routing, request parsing, job submission/retrieval, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, progress updates, durable retries, heartbeat, restart recovery, and shutdown.
- `ui/index.html`: Implement the form, validation error region, job list, polling, and basic styling.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the persistent model and initialize it from both entry points.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL configuration.
   - Use `CREATE TABLE/INDEX IF NOT EXISTS` so either process can initialize an empty database.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, output, error, ISO creation/update timestamps, nullable unique idempotency key, and numeric retry deadline.
   - Use the insertion sequence for deterministic oldest/newest ordering, including submissions sharing a timestamp.
   - Add a singleton worker heartbeat row containing the last heartbeat time.
   - Centralize row-to-JSON conversion. Return only the specified public fields; construct `progress` and `result`, and explicitly return `null` for absent results/errors.
   - Use parameterized SQL. Keep transactions synchronous and short, rolling back on exceptions; never hold a transaction over a timer or request-body read.

2. **Implement complete validation before accessing idempotency or creating jobs.**
   - Read the request body asynchronously and parse JSON inside error handling.
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or different media types with field `"body"`.
   - Reject malformed JSON, `null`, arrays, and non-object values with field `"body"`.
   - For an object, collect all applicable field errors: unknown own properties, missing/invalid input, invalid steps, and invalid failAttempts.
   - Check input with JavaScript `.length` and `.trim()` for validation only; preserve the original string in storage.
   - Apply defaults only when a property is absent. Explicit `null`, numeric strings, booleans, fractional numbers, and out-of-range values are invalid.
   - Validate a supplied `Idempotency-Key` against the exact regex, reporting field `"Idempotency-Key"`. Reject duplicate key headers rather than silently selecting one.
   - Return `400` with `error.code`, a useful message, and the complete available `fields` list. Header errors can be included alongside body errors.

3. **Implement routing and transactional submissions.**
   - Match the URL pathname independently of the method, then enforce allowed methods:
     - `/`: GET, serving HTML.
     - `/health`: GET.
     - `/api/jobs`: GET and POST.
     - `/api/jobs/:id`: GET, matching exactly one nonempty path segment.
   - Return JSON `405 method_not_allowed` for unsupported methods on recognized routes, optionally including `Allow`; unknown paths return JSON `404 not_found`.
   - Handle malformed URLs/encoding without crashing the process.
   - For POST, generate IDs with `randomUUID()`. Within `BEGIN IMMEDIATE`, look up any supplied key and compare the three normalized payload values against the stored immutable job values.
   - Return the current original job with `200` for an identical replay, or `409 idempotency_conflict` for a different payload.
   - Otherwise insert a queued job with attempts/progress zero, null result/error, and equal creation/update timestamps. Capture its initial representation inside the transaction and return it with `201`, even if the worker immediately claims it.
   - Enforce key uniqueness in SQLite as well as application logic. Omitted keys are SQL `NULL`, allowing unlimited independent submissions.
   - List jobs by descending insertion sequence; retrieve individual jobs by public ID.
   - Ensure all API errors, including unexpected failures, use JSON responses without leaking internals.
   - Continue loading HTML with the existing module-relative path, which works from `dist/server.js`.

4. **Implement the worker state machine.**
   - Poll for eligible queued jobs every 100 ms, processing one job at a time.
   - Claim the oldest eligible job in a short transaction: select a queued row whose retry deadline has passed, change it to running, increment attempts, reset progress to zero, clear output/error, and update its timestamp.
   - Sleep approximately 100 ms before each step. Commit each step independently so another connection can observe progress.
   - At the first step, if the attempt number is at most `failAttempts`, fail before recording any progress.
   - For simulated failures on attempts 1 or 2, atomically return the same job to queued with zero progress, null output/error, and a retry deadline 500 ms in the future.
   - For a simulated failure on attempt 3, atomically mark failed with exactly `"transient failure"`, null output, and zero progress.
   - A future retry deadline makes that job ineligible; other eligible jobs may run while it waits.
   - On successful final-step completion, atomically store the final progress, completed status, and `input.toUpperCase()` output. Do not expose completed status before its result exists.
   - Never select completed or failed jobs for processing.

5. **Implement heartbeat, recovery, and process lifecycle.**
   - Write a heartbeat immediately at worker startup and every 500 ms while idle, running, or waiting for retries. Keep processing sleeps asynchronous so heartbeat updates continue.
   - `/health` returns worker up only when a stored heartbeat is at most 3 seconds old. The server never refreshes it.
   - Recover interrupted running jobs before normal queue processing. Reset their progress and process them again without losing input or creating another job.
   - Make the restart accounting policy explicit: for interrupted attempts below 3, requeue and start the next counted attempt. If attempt 3 was interrupted, recover that already-started attempt from step zero instead of creating attempt 4 or inventing a transient failure. Apply the same first-step failure condition to recovered execution.
   - Preserve persisted retry deadlines across restarts. Recovery must begin promptly, within the required 10-second window.
   - This design targets the requested single worker process; recovery belongs to worker startup, never server startup.
   - On worker SIGTERM/SIGINT, stop claiming jobs, stop after the current short sleep/step boundary, retain unfinished running state for recovery, clear the heartbeat, cancel timers, and close SQLite.
   - On server SIGTERM/SIGINT, stop accepting connections, allow active handlers to finish, close idle connections, and close SQLite afterward. Bound shutdown of stalled connections so the process exits cleanly.
   - Treat database or programming errors separately from simulated transient failures; log unexpected failures and exit cleanly rather than recording fabricated job outcomes.

6. **Build the browser page.**
   - Add the exact required `data-testid` attributes and nest status, progress, and result elements within each job item carrying `data-job-id`.
   - Include labeled input, steps, and fail-attempts fields, with defaults 5 and 0 for the numeric fields.
   - Use `novalidate` on the form so browser constraints do not suppress API validation and its field-specific feedback.
   - On submission, send the text exactly as entered and numeric fields as JSON numbers. Do not use permissive `parseInt`; preserve invalid input as an invalid API value rather than silently fixing it.
   - Clear `form-error` when beginning a submission and after success. On API rejection, show its message plus every returned field name and message in the region with `role="alert"`.
   - Fetch the job list immediately on load, after successful submissions, and approximately every 500 ms.
   - Serialize refreshes or discard stale responses so an older fetch cannot overwrite newer state. Keep the form intact during list updates.
   - Render jobs in API order and use `textContent` for submitted input, outputs, and errors.
   - Show status verbatim, progress as `completed/total`, output for completed jobs, error for failed jobs, and otherwise empty result text.
   - Handle polling failures without stopping later refreshes or replacing submission errors.

7. **Build and verify the finished implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with focused HTTP, process-restart, and browser checks below. The existing checks explicitly omit much of validation, persistence, and the UI.
   - Use fresh temporary database paths for independent scenarios and retain the same path within restart scenarios. Do not modify the fixed checks or configuration.

## Behaviours to verify
- **Independent startup:** Start server alone and confirm worker down; start worker first against a missing parent directory, then server. Both startup orders should work within 10 seconds.
- **Exact job shape:** Submit without a worker and inspect queued defaults, null values, ISO timestamps, and exact whitespace preservation. Verify JavaScript Unicode uppercasing after starting the worker.
- **Validation:** Exercise malformed JSON, missing/non-JSON content types, scalar/array bodies, empty/whitespace/overlong input, unknown fields, nulls, numeric strings, fractions, range boundaries, and invalid keys. A request with several invalid fields must name all of them and leave the job count unchanged.
- **Routing:** Check unknown paths, missing job IDs, query strings, and unsupported methods on every known route; verify JSON content types and error codes.
- **Idempotency:** Replay omitted versus explicit defaults; test changed input, steps, and failAttempts; issue concurrent submissions with one key. Repeat after server restart and verify only one job exists. Unkeyed identical submissions must create separate jobs.
- **Scheduling/progress:** Queue multiple jobs with the worker stopped, then start it and observe oldest-first claims. Poll a 20-step job frequently to observe intermediate progress and roughly 100 ms steps; verify prompt pickup when idle.
- **Retries:** Test failAttempts 0 through 5. Confirm attempts 1, 2, and 3 for eventual successes; values 3–5 must fail at attempt 3 with the exact error, no progress, and no duplicate jobs. Observe queued retry waits of at least 250 ms.
- **Durability:** Stop and restart both processes with SIGTERM and SIGKILL using the same database. Verify queued jobs, delayed retries, terminal results, and idempotency keys survive. Kill the worker during a long job and during attempt 3 to exercise recovery and the attempt cap.
- **Heartbeat/shutdown:** Observe worker up during long processing and retries, then down within 3 seconds after SIGKILL. Verify both processes exit promptly on SIGTERM.
- **Browser:** Submit valid and invalid jobs, confirm numeric payload types and field-name errors, inspect all required selectors, and observe progress/completion without reload within 2 seconds. Reload the page and verify persisted job
[truncated]