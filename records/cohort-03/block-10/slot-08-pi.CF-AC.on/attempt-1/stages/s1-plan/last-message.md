# Plan

## Approach
Extend the existing TypeScript entry points using only Node.js built-ins. SQLite will hold jobs, idempotency keys, retry deadlines, and worker heartbeats; the server and worker will communicate exclusively through it. Use short transactions for state transitions and asynchronous timers for processing, keeping progress and health observable. Serve the browser application from the existing `ui/index.html`, polling the API every 500 ms.

## Files
- `src/db.ts`: Extend database initialization with schema creation, typed job mapping, prepared queries, and transactional persistence operations.
- `src/jobs.ts`: Add job/payload types and request validation with aggregated field errors.
- `src/server.ts`: Implement API routing, request parsing, idempotent submission, health reporting, HTML serving, and shutdown.
- `src/worker.ts`: Implement heartbeat, queue selection, processing, retries, restart recovery, and shutdown.
- `ui/index.html`: Implement the required form, accessible error region, job list, and polling.
- Leave configuration, dependencies, command scripts, and `checks/` unchanged.

## Steps
1. **Define the shared database schema and initialization.**
   - Preserve parent-directory creation and the existing ordering of `busy_timeout` before WAL initialization.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from either process, so either startup order works.
   - Store jobs with an internal monotonic integer sequence, unique public UUID, status, exact input, steps, fail-attempt count, attempts, completed steps, nullable output/error, ISO creation/update timestamps, and an epoch-millisecond retry deadline.
   - Store the optional idempotency key in a nullable unique column on the job. Compare immutable input, steps, and fail-attempt columns directly for replay matching.
   - Add a singleton worker-heartbeat table. Use integer epoch milliseconds for heartbeat age.
   - Use the sequence for deterministic oldest/newest ordering, including submissions with identical timestamps.
   - Centralize serialization into the exact public job shape. Hide internal fields; derive `progress.total` from `steps`, and return explicit `null` for absent result/error.
   - Use parameterized statements. Wrap multi-statement mutations in `BEGIN IMMEDIATE` with commit/rollback, never holding a transaction across an `await`.

2. **Implement validation before database mutation.**
   - Accept `application/json` case-insensitively, including parameters such as `charset=utf-8`; reject missing or different media types with field `"body"`.
   - Read the complete body and parse JSON. Empty/malformed JSON, arrays, `null`, and primitive values produce `"body"` errors.
   - For object bodies, collect every unknown field and every invalid recognized field instead of stopping at the first error.
   - Require a string input with JavaScript `.length` from 1–1000 and a nonempty `.trim()`, while storing the original string unchanged.
   - Apply numeric defaults only when the property is absent. Reject `null`, booleans, numeric strings, fractions, and out-of-range values.
   - Validate a present `Idempotency-Key` against the exact required pattern; reject empty or duplicate/multivalued headers rather than silently choosing one.
   - Aggregate header and body/field errors where possible. Every `invalid_request` includes `fields` with field names and useful messages.

3. **Implement the HTTP API and atomic idempotency.**
   - Retain the existing module-relative HTML path; it resolves correctly from `dist/server.js`.
   - Route by pathname, independently of query parameters. Recognize `/`, `/health`, `/api/jobs`, and single-segment `/api/jobs/:id`.
   - Determine whether the route exists before dispatching its method: unsupported methods on recognized routes return `405 method_not_allowed`; unmatched paths return `404 not_found`.
   - Send every API response and route error through one JSON response helper. Only successful `GET /` serves HTML.
   - For submission, validate and normalize first. In one short write transaction, look up a supplied key and either return its existing job, report a payload conflict, or insert a new UUID-backed queued job.
   - Return the inserted queued snapshot with `201`, rather than rereading after commit when the worker might already have claimed it. Replays return the existing job’s current state with `200`.
   - Initialize attempts/progress to zero, result/error to null, and both timestamps to the same ISO value.
   - Implement list ordering by descending sequence and individual lookup with a structured `404`.
   - `/health` returns worker `"up"` only when a persisted heartbeat is at most 3 seconds old.
   - Catch asynchronous request failures so rejected handlers do not crash the process. Return structured internal errors for unexpected failures without exposing SQL details.

4. **Implement worker scheduling and heartbeat.**
   - Write a heartbeat immediately after initialization and every 500 ms thereafter, including while idle, processing, or awaiting retry deadlines.
   - Poll for work every 100 ms. Select the oldest queued job whose persisted retry deadline has passed.
   - Atomically claim it, setting `running`, incrementing attempts, resetting progress to zero, clearing result/error, and updating its timestamp.
   - Process one job at a time with awaited 100 ms step delays. Persist each completed step in a separate short update.
   - On a simulated failure, wait for the first step’s timer, then fail before incrementing progress when the current attempt number is at most `failAttempts`.
   - For failed attempts below three, atomically return the same job to `queued`, leave error/result null, and set a retry deadline 500 ms ahead. Do not immediately reclaim it.
   - On the third simulated failure, set `failed`, error `"transient failure"`, result null, and progress zero.
   - On successful steps, increment progress. Commit the last increment, `completed` status, and JavaScript `input.toUpperCase()` output together.
   - Keep heartbeat writes separate from processing semantics; health must remain current during a 20-step job.

5. **Implement restart recovery and clean termination.**
   - Under the task’s single-worker topology, inspect stale `running` jobs when the worker starts and make them recoverable immediately. The server must never reset running jobs.
   - Preserve job IDs, creation timestamps, idempotency mappings, and attempts already recorded. Reset partial progress when reprocessing an interrupted job.
   - Persist retry deadlines so restarting does not erase an outstanding retry wait.
   - Explicitly handle interruption during attempt three: do not strand the job or create a fourth ordinary retry. Recover the interrupted third attempt by replaying its work from zero with its existing attempt number; its simulated-failure rule remains unchanged. For earlier interrupted attempts, requeue and start the next recorded attempt.
   - Never recover or claim terminal jobs.
   - On worker `SIGTERM`/`SIGINT`, stop taking new jobs, finish the current bounded attempt, clear heartbeat/timers, close SQLite, and exit. A resulting queued retry remains durable for the next worker.
   - On server shutdown, stop accepting requests, allow active handlers to finish, close idle connections, and close SQLite afterward. Bound shutdown of lingering connections.
   - Use `finally` cleanup for both processes. Abrupt termination requires no cleanup for committed SQLite state to survive.

6. **Build the browser page.**
   - Add the required `job-form`, input/steps/fail-attempt fields, submit button, empty `form-error` with `role="alert"`, and `job-list`.
   - Default numeric controls to 5 and 0. Use `novalidate` so browser constraints do not prevent API rejection messages from being shown.
   - Submit exact input text and numeric values converted to numbers. Treat empty/invalid numeric entries as invalid values rather than silently substituting defaults or converting empty text to zero.
   - Clear submission errors on a new submission and after success. On API rejection, show the message and every offending field name.
   - Fetch jobs on page load, immediately after successful submission, and every 500 ms. Serialize refreshes or discard stale responses so an older response cannot overwrite newer state.
   - Render newest first. Each job gets `data-testid="job-item"` and `data-job-id`; nested status, progress, and result elements use the specified attributes and text.
   - Render user content through `textContent`, never interpolated HTML. Show output only for completed jobs, error only for failed jobs, and empty result text otherwise.
   - Keep polling failures separate from the submission-error region and recover on subsequent polls.

7. **Build and verify the implementation.**
   - Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`.
   - Supplement the disclosed checks with HTTP, process-restart, and browser checks below; the existing suites explicitly omit substantial contract coverage.
   - Keep any additional verification helpers under `src/` if committed; do not modify fixed files or add dependencies.

## Behaviours to verify
- **Startup/configuration:** Start each process first in separate runs, using a fresh nested `DATABASE_PATH` and custom port. Verify readiness within 10 seconds and automatic directory/schema creation.
- **Validation:** Exercise malformed/empty JSON, wrong media types, nonobjects, whitespace input, Unicode length boundaries, unknown fields, numeric strings, fractions, nulls, and multiple simultaneous errors. Confirm field names and unchanged job count.
- **Routing:** Check unknown paths, missing IDs, and unsupported methods on every known route; verify JSON error codes and content types.
- **Idempotency:** Send concurrent identical-key submissions, then conflicting payloads. Compare omitted versus explicit defaults. Restart the server and replay again; exactly one job must exist.
- **Ordering:** Submit several jobs with the worker stopped, including rapid submissions. Verify newest-first listing and oldest-first processing after worker startup.
- **Progress and output:** Poll a 20-step job every 50 ms. Observe running progress, approximately 100 ms step spacing, stable attempt count, and final output matching JavaScript uppercase behavior, including Unicode.
- **Retry rules:** Test `failAttempts` from 0 through 5. Verify final attempts are 1, 2, or 3 as appropriate, failed attempts make no progress, retry waits are at least 250 ms, and failures use the exact required error.
- **Health:** Observe `"down"` without a worker, `"up"` while idle/busy/retrying, and `"down"` within the heartbeat expiry after killing it.
- **Durability:** Kill the worker during processing and retry waits; restart on the same database. Also stop both processes and restart in reversed order. Verify recovery, retained IDs/state, and no reprocessing of completed/failed jobs.
- **Shutdown:** Send `SIGTERM` to the actual processes or process groups; confirm timely clean exits without pending timers or locked database failures on restart.
- **Browser:** Check every required selector, numeric submission payloads, multi-field rejection text, initial persistent jobs, automatic updates within 2 seconds, failed/completed result text, and harmless rendering of HTML-like input.

## Risks
- **Concurrent SQLite initialization or writes:** Preserve the existing busy-timeout setup and keep transactions short; never sleep while holding a write lock.
- **Idempotency races:** A lookup followed by an unprotected insert is insufficient. Use a transaction plus a unique database constraint.
- **Crash recovery versus retry limits:** Interrupted work needs an explicit exhausted-attempt path; otherwise restart can leave jobs stuck or create unlimited retries.
- **Premature/stale API state:** Return the insertion snapshot for `201`, while replay and lookup return current durable state.
- **UI bypassing validation:** Native form constraints or client-side coercion can hide API errors. Let the API validate submissions and display its field names.
- **False confidence from supplied checks:** Passing smoke and contract checks does not establish restart durability, complete validation, timing, or browser correctness.