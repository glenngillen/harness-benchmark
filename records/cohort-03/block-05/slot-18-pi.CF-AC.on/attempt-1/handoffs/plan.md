# Plan

## Approach
Extend the existing TypeScript server, worker, and database helper using only Node.js built-ins. Store jobs, idempotency keys, retry deadlines, and worker heartbeats in SQLite; use short transactions so HTTP requests and worker updates can run concurrently. Keep processing asynchronous with persisted progress after every step, and serve a plain HTML/JavaScript page that polls the API. Preserve the existing commands, configuration defaults, and file layout.

## Files
- `src/db.ts`: Extend database initialization with schema, prepared queries, transactions, job serialization, and durable worker state.
- `src/jobs.ts`: Add shared job types and submission validation/default normalization.
- `src/server.ts`: Implement routing, JSON request handling, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement job selection, processing, retries, heartbeat updates, recovery, and graceful shutdown.
- `ui/index.html`: Implement the submission form, validation error display, job list, and polling.
- Leave all fixed files and `checks/` unchanged.

## Steps
1. **Define the public model and validation.**
   - Define the exact public job representation separately from internal database columns.
   - Validate parsed JSON as a non-null, non-array object.
   - Collect all offending fields, including unknown keys. Use own-property checks to distinguish omitted fields from explicitly supplied invalid values.
   - Require `input` to be a string with JavaScript `.length` between 1 and 1000 and a nonempty `.trim()`. Store its original value.
   - Default omitted `steps` to 5 and omitted `failAttempts` to 0. Require actual numbers satisfying `Number.isInteger()` and the specified ranges.
   - Validate any supplied `Idempotency-Key` against the exact regex, including rejecting an empty value.
   - Normalize valid payloads to a fixed property order before serializing them for idempotency comparison.

2. **Initialize durable storage from either process.**
   - Preserve the existing directory creation and `busy_timeout`-before-WAL initialization.
   - Create schema with `CREATE TABLE IF NOT EXISTS`, safely supporting simultaneous server and worker startup.
   - Store jobs with:
     - An integer insertion sequence for deterministic ordering.
     - A unique public ID generated with `randomUUID()`.
     - Input, steps, failure configuration, status, attempts, completed steps, output, error, and ISO timestamps.
     - An internal `available_at` timestamp for retry eligibility.
     - A nullable unique idempotency key and normalized payload string.
   - Add a worker-state table containing its last heartbeat timestamp.
   - Index job selection by status/eligibility and insertion sequence.
   - Centralize serialization so every endpoint returns exactly the required shape. Never expose internal columns; construct `result` only for completed jobs and `error` only for failed jobs.
   - Provide a synchronous transaction helper using `BEGIN IMMEDIATE`, `COMMIT`, and rollback on error. Never hold a transaction across an `await`.

3. **Implement HTTP routing and request handling.**
   - Retain the existing UI file resolution relative to `import.meta.url`; it works from both the source and compiled layout.
   - Match paths first, then methods:
     - `/`: GET serves HTML.
     - `/health`: GET returns JSON health.
     - `/api/jobs`: GET lists jobs, POST submits.
     - `/api/jobs/:id`: GET retrieves one job.
   - Return JSON `405 method_not_allowed` for unsupported methods on these paths, and JSON `404 not_found` for unknown paths or missing jobs. Extra path segments must not match a job route.
   - Use one JSON response helper and one structured error helper.
   - For submissions, accept the `application/json` media type case-insensitively, including parameters such as `charset=utf-8`. Reject absent or other media types with field `"body"`.
   - Read the complete request before parsing JSON. Report malformed JSON and non-object bodies with field `"body"`, and combine independently detectable header/body validation errors where possible.
   - Catch request failures and handler exceptions without crashing the server or generating unhandled promise rejections.
   - List jobs by insertion sequence descending; worker ordering uses ascending sequence.

4. **Make job creation and idempotency atomic.**
   - Complete validation before accessing or creating an idempotency record.
   - Within one immediate transaction, look up a supplied key:
     - Equal normalized payload: return the original job’s current representation with `200`.
     - Different payload: return `409 idempotency_conflict`.
     - Absent key: insert a queued job with attempts/progress zero, null result/error, and matching initial timestamps.
   - Keep the key and payload in the job row so their persistence is atomic with creation. Enforce key uniqueness in SQLite, not only in application logic.
   - Return the inserted queued snapshot with `201`. Capture it before committing/releasing the transaction so a fast worker cannot change the creation response to `running`.
   - Submissions without a key always insert a new row.

5. **Implement the worker loop and heartbeat.**
   - Write a heartbeat immediately after initialization and approximately every 500 ms, including during processing and retry waits.
   - `/health` reports `"up"` only when the stored heartbeat is at most 3000 ms old. The server never writes worker liveness.
   - Poll for work every 100 ms when idle.
   - Atomically select and claim the oldest eligible queued job using an immediate transaction. Eligibility requires `available_at <= now`; a delayed retry must not prevent other eligible jobs from running.
   - Claiming a new attempt sets `running`, increments attempts, resets progress to zero, clears result/error, and updates `updatedAt`.
   - Process only one job at a time. Await about 100 ms per step, then commit that step’s progress.
   - On the final successful step, atomically store full progress, `completed`, and JavaScript `input.toUpperCase()` as the output.
   - Update `updatedAt` on every job state/progress change.

6. **Implement transient failures and persisted retry delays.**
   - After the first step’s approximately 100 ms delay, check whether the attempt number is at most `failAttempts`. If so, fail before incrementing progress.
   - For failed attempts 1 and 2, set status back to `queued`, keep attempts unchanged, keep progress at zero and result/error null, and persist `available_at = now + 500 ms`.
   - After the third transient failure, atomically store `failed`, attempts 3, progress zero, null result, and error `"transient failure"`.
   - Reuse the same job row throughout; never create result or retry jobs.
   - Do not implement retry waiting solely with an in-memory timer: restarting must preserve the remaining delay.

7. **Handle restart recovery and shutdown explicitly.**
   - On worker startup, recover any `running` job before selecting ordinary queued work. Recovery must be performed only by the worker, never by the server.
   - Treat an interrupted durable attempt as unfinished: replay it from step zero using its existing attempt number. Preserve the count already incremented when that attempt was claimed; normal transient retries still increment on their next claim.
   - This recovery policy avoids consuming extra transient retry budget merely because a process crashed, including when a successful third attempt was interrupted. Keep this distinction explicit in code comments.
   - Persist the reset progress before replaying. Leave completed and failed rows untouched.
   - On worker SIGTERM/SIGINT, stop accepting new work, interrupt processing at a step boundary, leave unfinished work recoverable, stop the heartbeat, clear its liveness record, and close SQLite.
   - On server SIGTERM/SIGINT, stop listening, allow active handlers to finish, close idle connections, and close SQLite after handlers finish. Bound shutdown if clients retain incomplete requests.
   - Do not force process exit before synchronous database writes finish. SIGKILL recovery must rely entirely on committed SQLite state.

8. **Build the browser page.**
   - Add all required `data-testid` attributes exactly as specified, plus labels and sensible defaults of 5 steps and 0 failed attempts.
   - Use a form with `novalidate` so browser constraints do not prevent API validation errors from reaching the required alert region.
   - Submit the input unchanged and convert numeric field values to numbers. Represent empty/invalid numeric values as invalid JSON values such as `null`, rather than accidentally defaulting them or converting blank failure counts to valid zero.
   - Send JSON with the correct content type. Disable the submit button while a request is pending.
   - Clear `form-error` on a new submission and after success. On API rejection, show its message and every field name/message using `textContent`.
   - Render jobs newest first, with each required child element inside its `job-item` and `data-job-id` set.
   - Display exact status text, `completed/total`, completed output, or terminal error as required.
   - Fetch the list immediately on load, after successful submission, and about every 500 ms. Serialize refreshes or discard stale responses so an older request cannot overwrite newer state.
   - Keep polling after temporary fetch failures without overwriting submission validation errors.
   - Use DOM creation and `textContent` for submitted text and results to avoid HTML injection.

## Behaviours to verify
- **Existing commands and startup:** Run `npm run build`, `npm run check:smoke`, and `npm run check:contract`. The inspected checks cover only examples, so continue with the scenarios below.
- **Configuration and process independence:** Start each process first in separate trials, using the same temporary `DATABASE_PATH` with a missing parent directory and a nondefault port. Confirm readiness within 10 seconds.
- **Validation completeness:** Submit malformed JSON, arrays, null, missing/wrong content types, whitespace-only input, input length boundaries, numeric strings, fractions, null fields, out-of-range numbers, unknown keys, and invalid idempotency keys. Confirm every relevant field is listed and job count is unchanged.
- **Routing and representation:** Exercise all endpoints, unknown paths, missing IDs, and unsupported methods. Check JSON content types, error codes, exact public fields, ISO timestamps, and newest-first ordering even for rapidly created jobs.
- **Idempotency durability:** Replay omitted versus explicit defaults; vary each payload field; send concurrent requests with one key; restart the server and replay again. Confirm one job and the correct `200`/`409` responses. Confirm unkeyed identical submissions create separate jobs.
- **Observable processing:** Submit a 20-step job and poll every 25–50 ms. Confirm pickup within 1 second when idle, running state, incremental progress at approximately 100 ms intervals, and correct uppercase output, including Unicode input.
- **Retries:** Exercise `failAttempts` 0 through 5. Confirm attempts 1/2/3 for eventual successes, terminal failure at 3 for values 3–5, zero progress on failed attempts, and queued delays between 250 ms and 2 seconds.
- **Health:** Confirm `"up"` during a long job and while idle; terminate or kill the worker and confirm `"down"` no later than heartbeat expiry.
- **Durability:** Restart both processes against the same database after SIGTERM and SIGKILL. Include queued, running, retry-waiting, completed, and failed jobs. Confirm terminal jobs remain unchanged, interrupted work recovers promptly, and idempotency mappings survive.
- **Recovery edge case:** Kill a `failAttempts: 2`, 20-step job during its third attempt; restart and confirm it completes without duplicating the job or incorrectly failing due to the crash.
- **Browser:** Ver
[truncated]