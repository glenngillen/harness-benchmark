# Plan

## Approach
Use Node.js built-ins and the existing TypeScript entry points, with SQLite as the only communication channel between server and worker. Initialize the same schema from either process, store every job transition durably, and use short transactions for submission and job claiming. Run one worker processing one job at a time, with persisted retry deadlines and a database heartbeat. Build the browser page with plain HTML and JavaScript that submits to the API and polls for updates.

## Files
- `src/db.ts`: Extend database initialization with shared schema, prepared queries, transactions, and job serialization.
- `src/jobs.ts`: Add shared job/payload types and submission validation.
- `src/server.ts`: Implement routing, JSON responses, submissions, idempotency, health, and graceful shutdown.
- `src/worker.ts`: Implement heartbeat, oldest-first processing, observable progress, retries, recovery, and shutdown.
- `ui/index.html`: Implement the form, errors, job list, and polling.
- Leave all fixed files and `checks/` unchanged. Preserve the existing build/start commands and source import conventions.

## Steps
1. **Define the database and public representation.**
   - Preserve parent-directory creation and the existing `busy_timeout` initialization before enabling WAL.
   - Initialize tables using `CREATE TABLE IF NOT EXISTS` in both processes.
   - Store jobs with an integer insertion sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed-step count, nullable output/error, ISO creation/update timestamps, nullable unique idempotency key, and numeric retry eligibility time.
   - Use the insertion sequence for deterministic oldest/newest ordering, including submissions created in the same millisecond.
   - Store worker heartbeat time in a separate singleton table. Schema initialization must not refresh the heartbeat.
   - Provide one serializer producing exactly the specified public shape; omit internal sequence, key, and retry metadata. Construct `progress.total` from `steps` and expose output only as `{ output }` for completed jobs.
   - Use parameterized SQL and rollback transactions on exceptions. Never hold transactions open during timers or request-body reads.

2. **Implement validation independently of persistence.**
   - Parse `Content-Type` case-insensitively, accepting `application/json` with optional parameters. Missing or different media types produce a `"body"` error.
   - Collect the complete request body before parsing JSON; malformed/empty JSON, arrays, `null`, and primitives produce a `"body"` error.
   - For objects, collect all unknown fields and all invalid recognized fields rather than returning after the first error.
   - Require a string input with JavaScript `.length` from 1 through 1000 and nonempty `.trim()`. Store the original string unchanged.
   - Apply defaults only when properties are absent. Explicit `null`, booleans, numeric strings, fractions, and out-of-range values must fail.
   - Validate `Idempotency-Key` against the exact required expression, reporting that field name. Reject duplicate header values rather than silently choosing one.
   - Combine detectable header/body/field errors into `400 invalid_request` with a required `fields` array. Perform no database mutation until validation succeeds.

3. **Implement submissions and idempotency atomically.**
   - Generate public IDs with `randomUUID()`.
   - In a short `BEGIN IMMEDIATE` transaction, look up a supplied key. Compare the existing job’s immutable input, steps, and failAttempts against the normalized payload.
   - Return the existing job with `200` when equal, or `409 idempotency_conflict` when different.
   - Otherwise insert a queued job with attempts/progress zero, null output/error, and matching initial timestamps. Persist the key on the same row, protected by its unique constraint.
   - Capture the inserted queued representation before committing, then return it with `201`; a worker claiming immediately afterward must not change the creation response to running.
   - A missing key always inserts a new job. Keys remain durable through terminal states and server restarts.

4. **Complete HTTP routing and lifecycle.**
   - Match pathname independently of method; then enforce the permitted methods. Known routes are `/`, `/health`, `/api/jobs`, and `/api/jobs/:id` with exactly one ID segment.
   - Serve the existing HTML location using `new URL('../ui/index.html', import.meta.url)` so it works from `dist/server.js`.
   - Implement list ordering by descending insertion sequence and individual lookup by public ID.
   - Return JSON errors for unknown paths (`404 not_found`) and wrong methods on recognized routes (`405 method_not_allowed`, optionally with `Allow`). A missing job on an otherwise valid GET returns `404`.
   - Centralize JSON headers and error envelopes. Catch asynchronous request failures so they cannot become unhandled rejections; unexpected failures receive a JSON server error.
   - Compute worker health from the stored heartbeat: up only when its age is at most 3000 ms; absent/stale means down.
   - Retain `PORT` default 3000 and the shared database configuration.
   - On SIGTERM/SIGINT, stop accepting connections, finish active requests, close the database after handlers finish, and exit. Bound shutdown for clients that leave requests open.

5. **Implement the worker state machine.**
   - Publish a heartbeat immediately after initialization and every approximately 500 ms while running, including during processing and retry waits.
   - Poll approximately every 100 ms when idle. In a short transaction, select the oldest eligible queued job and atomically set it running, increment attempts, reset progress to zero, and clear output/error. Preserve the original creation time.
   - Select using `available_at <= now`, ordered by insertion sequence; a delayed retry does not prevent processing other eligible jobs.
   - Sleep approximately 100 ms for each step using asynchronous timers. After each successful step, commit the new progress and updated timestamp.
   - On the first step, if the current attempt number is at most failAttempts, fail before recording progress:
     - Attempts 1–2: return the same job to queued with zero progress, null output/error, and a persisted eligibility deadline approximately 500 ms later.
     - Attempt 3: mark failed with exactly `"transient failure"`, null output, and zero progress.
   - On the final successful step, atomically persist completed status, full progress, and `input.toUpperCase()`. Do not create separate result records.
   - Maintain a single sequential processing loop; heartbeat callbacks must not claim or process work.

6. **Handle restarts and process termination explicitly.**
   - For the required single-worker deployment, inspect persisted running jobs before claiming fresh queued jobs on startup. Terminal jobs are never selected.
   - Replay an interrupted running job from step zero as recovery of its persisted attempt, retaining its attempt number. This avoids a crash during a successful third attempt causing an invented fourth retry or an unsupported terminal error; subsequent simulated failures still follow the three-attempt rules.
   - Persist the reset progress and updated timestamp before replay. Preserve queued retry deadlines across restarts.
   - On SIGTERM/SIGINT, stop claiming work, wake or cancel pending waits, and prevent further step writes after shutdown begins. Leave an interrupted job running for startup recovery.
   - Clear the heartbeat on graceful worker exit, stop timers, and close SQLite. After SIGKILL, health naturally becomes down once the heartbeat expires.
   - Recovery should begin immediately, comfortably within the ten-second recovery allowance.

7. **Build the browser interface.**
   - Include every specified `data-testid` exactly, including an always-present empty `form-error` with `role="alert"`.
   - Use a textarea for input, editable numeric fields initialized to 5 and 0, and a submit button inside `job-form`. Use `novalidate` so API validation and its errors remain observable.
   - Preserve input whitespace. Convert numeric field values to numbers; send invalid/empty numeric entries as an invalid value such as `null`, rather than silently substituting a default.
   - Submit JSON to `/api/jobs`. Clear the previous error when a new submission begins; display the API rejection message and every offending field name on failure. Handle network failures visibly.
   - Refresh the list immediately after successful submission and poll approximately every 500 ms, starting on page load. Use sequential refreshes or request sequencing so stale responses cannot overwrite newer state.
   - Render jobs in API order with `job-item` and `data-job-id`, status, exact `completed/total` progress, and output/error as specified.
   - Use `textContent` for user input, results, and errors. Updating the job list must not replace the form or erase a submission error.

8. **Build and verify the completed implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - The disclosed checks cover only examples; perform the additional checks below using temporary databases and the existing commands. Do not modify the fixed checks or package scripts.

## Behaviours to verify
- **Startup/configuration:** Start worker first, server first, and both simultaneously against a missing nested database path. Both become ready within ten seconds; custom PORT and DATABASE_PATH work.
- **Representation and ordering:** Submit several jobs quickly; confirm exact response fields, queued creation snapshots, deterministic newest-first listing, unchanged input, and ISO timestamps.
- **Validation:** Exercise unknown fields, multiple simultaneous errors, missing input, whitespace, boundary lengths including surrogate pairs, numeric strings, nulls, fractional/out-of-range numbers, malformed JSON, arrays, missing/wrong media type, and invalid keys. Confirm all applicable fields are named and job count is unchanged.
- **Routes:** Check every supported method, wrong methods on each known route, unknown paths, and nonexistent IDs. Verify JSON content types and error codes.
- **Idempotency:** Compare omitted defaults with explicit defaults, change each payload field, replay after completion and restart, and issue concurrent submissions with one key. Confirm one durable job and appropriate 200/201/409 responses.
- **Processing:** Poll a 20-step job frequently enough to observe intermediate progress. Confirm pickup under one second when idle, approximately 100 ms steps, uppercase Unicode output, and one-at-a-time processing.
- **Retries:** Test failAttempts 0 through 5; expected terminal attempts are 1, 2, 3, 3, 3, 3. Observe queued retry waits, zero failure progress, null nonterminal errors, and no duplicate jobs.
- **Durability:** Kill the worker during partial progress, during a retry delay, and during a successful third attempt. Restart with the same database and confirm recovery, retained IDs, correct results, and no reprocessing of terminal jobs. Also restart both processes.
- **Health/shutdown:** Verify up while idle and busy, down after graceful exit or within three seconds of a killed worker’s last heartbeat, and prompt SIGTERM exits.
- **Browser:** Use the prescribed selectors to submit valid and invalid jobs, inspect field-specific alerts, observe progress/status updates within two seconds, and reload to see persisted jobs. Verify HTML-looking input renders as text.

## Risks
- **Crash recovery versus retry accounting:** Keep recovery of an interrupted attempt distinct from a retry after a recorded transient failure. Never decrement persisted attempts or consume another retry merely while initializing.
- **SQLite contention:** Preserve busy timeout before WAL initialization, keep write transactions short, and make schema initialization safe from either process.
- **Creation-response races:** Return the queued snapshot captured during insertion, not a post-commit reread that may already show running.
- **Lost retry timing:** Store eligibility deadlines in SQLite; an in-memory timeout alone cannot survive restart.
- **Validation bypass:** Avoid truthiness-based defaults, implicit coercion in the API, and browser validation that prevents API errors from appearing.
- **Stale UI and heartbeat state:** Keep polling ordered, heartbeat independent of job duration, and timers explicitly cleaned up during shutdown.