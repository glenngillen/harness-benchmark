# Plan

## Approach
Keep the existing TypeScript entry points and npm commands, using only Node.js built-ins. Share database initialization, job serialization, and transactional state changes between the HTTP server and the separate worker; SQLite is their only communication channel. Persist jobs, idempotency keys, retry deadlines, and worker heartbeats so restarts do not lose state. Serve a self-contained browser page that submits through the API and polls for updates.

## Files
- `src/db.ts`: Extend the existing database opener with schema initialization, prepared queries, transactions, and durable worker heartbeat storage.
- `src/jobs.ts`: Add job types, normalized submission types, validation, and a single public job serializer.
- `src/server.ts`: Implement routing, request parsing, validation, idempotent creation, health reporting, and graceful shutdown.
- `src/worker.ts`: Implement sequential processing, observable progress, retries, restart recovery, heartbeats, and graceful shutdown.
- `ui/index.html`: Add the submission form, job list, error display, polling script, and lightweight styling.
- Leave all fixed files and `checks/` untouched.

## Steps
1. **Define the shared schema and public representation.**
   - Retain parent-directory creation and the existing ordering of `busy_timeout` before WAL configuration. Use short transactions and explicit durable SQLite settings, such as `synchronous=FULL`.
   - Initialize tables with `CREATE TABLE IF NOT EXISTS` from either process, allowing either startup order.
   - Store jobs with an internal monotonically increasing sequence, unique public UUID, status, original input, steps, fail-attempt count, attempts, completed steps, output, error, creation/update timestamps, and a numeric retry deadline.
   - Store an optional idempotency key under a unique constraint, either directly on the job or in a linked table. Multiple jobs without keys must remain possible.
   - Store a singleton worker heartbeat timestamp. Only the worker writes it.
   - Use the internal sequence for deterministic newest-first listing and oldest-first processing, including jobs created within the same millisecond.
   - Centralize serialization to emit exactly the specified job shape. Hide internal columns; derive `progress.total` from `steps`, and expose `result` and `error` only for their respective terminal statuses.

2. **Implement complete validation before any database mutation.**
   - Read the request stream and parse JSON, handling malformed JSON and stream failures without an unhandled rejection.
   - Accept the `application/json` media type case-insensitively, including parameters such as `charset=utf-8`; missing or other media types produce a `"body"` field error.
   - Require a non-null, non-array JSON object. Use `"body"` for malformed JSON or a non-object body.
   - Enumerate unknown own properties and report every offending field.
   - Validate `input` using JavaScript string length and `trim()` only for the whitespace test; store the original string unchanged.
   - Apply defaults only when `steps` or `failAttempts` is absent. Reject null, strings, booleans, fractional numbers, and out-of-range values.
   - Validate the optional `Idempotency-Key` against the exact required expression. Reject ambiguous duplicate header values rather than silently choosing one.
   - Accumulate all applicable errors, including header errors, into `invalid_request.fields`; do not stop after the first invalid object property.

3. **Make creation and idempotency atomic.**
   - Normalize to `{input, steps, failAttempts}` after successful validation.
   - Use `BEGIN IMMEDIATE` around key lookup, comparison, and insertion; commit or roll back on every path.
   - For an existing key, compare the three normalized values directly. Return its current job representation with `200`, or `409 idempotency_conflict` for a mismatch.
   - For a new submission, assign `randomUUID()`, initialize queued state, zero attempts/progress, null result/error, and ISO timestamps.
   - Capture the newly inserted queued representation inside the transaction and return it with `201`. Do not re-read it after committing, since the worker could already have claimed it.
   - Back the transactional logic with a unique database constraint so persistence and concurrent submissions cannot create duplicates.

4. **Implement the HTTP routes and lifecycle.**
   - Match paths independently of methods. Support `GET /`, `GET /health`, `GET` and `POST /api/jobs`, and `GET /api/jobs/:id`.
   - Return `405 method_not_allowed` for unsupported methods on recognized paths, optionally with `Allow`; return `404 not_found` for unknown paths and missing job IDs.
   - Use one JSON response/error helper for all API responses, including unexpected failures. Every `invalid_request` includes `fields`.
   - Compute worker health from the persisted heartbeat: up only when it exists and is no more than three seconds old. The server must never infer health from job status or update the heartbeat itself.
   - Preserve the existing `new URL('../ui/index.html', import.meta.url)` asset lookup, which works from the compiled `dist/server.js`.
   - On `SIGTERM`/`SIGINT`, stop accepting requests, finish active handlers, then close SQLite. Bound shutdown for stalled connections and avoid closing the database while handlers still use it.

5. **Implement the worker’s durable state machine.**
   - Write a heartbeat immediately after initialization and every 500 ms while idle, processing, or waiting for a retry. Use asynchronous timers so step delays do not block heartbeats.
   - Recover an interrupted `running` job before selecting ordinary queued work. Under the specified single-worker deployment, startup can recover it immediately.
   - Treat recovery as continuation of its already-recorded attempt: preserve `attempts`, reset progress, and replay that attempt’s processing from the beginning. This avoids charging an interrupted attempt twice or turning a crash on attempt three into an unintended fourth retry.
   - Poll eligible queued jobs about every 100 ms. Select the oldest whose persisted retry deadline has passed.
   - Claim a queued job transactionally: change it to `running`, increment attempts, reset progress, clear result/error, and update its timestamp. Never hold a transaction open across a sleep.
   - Wait approximately 100 ms per step. At the first step, if the current attempt number is at most `failAttempts`, fail before recording any progress.
   - For a simulated failure on attempts one or two, atomically return the job to `queued`, retain zero progress and null public error/result, and persist a retry deadline 500 ms in the future.
   - For the third simulated failure, atomically mark it `failed` with exactly `"transient failure"` and null result.
   - For successful steps, persist completed progress and `updatedAt` after each delay. On the last step, atomically set completed progress, status `completed`, and output from JavaScript `input.toUpperCase()`.
   - Never select completed or failed jobs. Database or programming errors must not be mislabeled as simulated transient failures.
   - On termination, stop claiming jobs and stop at a step boundary. Leave any interrupted job durably `running` for recovery, clear the heartbeat, cancel timers, and close SQLite.

6. **Build the browser page around the API contract.**
   - Add every required `data-testid`, with each job item carrying `data-job-id`. Keep `form-error` present with `role="alert"` even when empty.
   - Default numeric controls to 5 and 0. Convert numeric values with `Number`, not `parseInt`, so fractional values are not silently truncated. Send an invalid empty numeric value as null rather than silently applying a default.
   - Use `novalidate` on the form so browser validation does not prevent the API from returning the required field errors.
   - On submit, clear the prior rejection, send JSON, and display the API error message plus every field name and field message on rejection. Clear the region after a successful submission.
   - Refresh the list immediately after successful submission and poll approximately every 500 ms. Serialize refreshes or discard stale responses to prevent older responses from replacing newer state.
   - Render server-provided newest-first order, exact status text, progress as `completed/total`, and terminal result/error text.
   - Use DOM creation and `textContent` for submitted text and results. Polling must not reset form fields or erase a submission rejection. Report connectivity failures separately from API field validation.

7. **Build and validate the completed implementation.**
   - Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`. These checks already launch both processes with isolated databases.
   - Supplement the disclosed checks with the cases below using temporary databases, HTTP requests, process control, and a browser. Do not modify the fixed checks or add dependencies.

## Behaviours to verify
- **Startup and configuration:** Start each process first, then start both concurrently against a new nested database path; confirm readiness within 10 seconds and correct custom `PORT`/`DATABASE_PATH`.
- **Validation:** Submit malformed JSON, arrays, null, missing content type, unknown fields, numeric strings, fractions, invalid bounds, whitespace input, and invalid keys. Check multiple simultaneous field errors and unchanged job count.
- **Defaults and exact input:** Compare omitted defaults with explicit defaults; confirm leading/trailing whitespace is preserved and Unicode output uses JavaScript uppercase semantics.
- **Idempotency:** Send concurrent requests sharing a key, replay after server restart, and reuse the key with changed payloads. Verify one job, matching replay IDs, and correct `200`/`409` responses. Requests without keys must create separate jobs.
- **Routing:** Exercise unsupported methods on every known route, unknown paths, and missing IDs; check status, code, and JSON content type.
- **Processing:** Poll a 20-step job frequently; observe running status and increasing progress, approximately 100 ms steps, and final output. With multiple queued jobs, confirm sequential oldest-first processing.
- **Retries:** Test `failAttempts` from 0 through 5. Confirm attempts of 1, 2, or 3 as appropriate, zero progress on simulated failures, observable queued retry delays, and the exact terminal failure message.
- **Health:** Check down without a worker, up while idle and busy, and down within three seconds after killing the worker.
- **Durability:** Stop and restart both processes using the same database. Kill the worker during processing and during a retry delay, including on attempt three; confirm recovery within the required window, retained retry deadlines, no duplicate jobs, and untouched terminal jobs.
- **Shutdown:** Send `SIGTERM` while idle and busy; confirm prompt clean exit, no lingering timer, and valid persisted state.
- **Browser:** Verify all selectors, numeric JSON values, multi-field rejection text, newest-first ordering, live progress/results within two seconds, and safe literal rendering of HTML-like input.

## Risks
- **SQLite contention:** Startup schema work and job claims can race. Retain busy timeout, initialize idempotently, use short transactions, and never sleep while holding a write lock.
- **Restart semantics:** Recovery must distinguish continuing an interrupted attempt from retrying a known failure. Preserve the durable attempt number for recovery and increment only when claiming a queued attempt.
- **Accidental state loss:** Never recreate tables or clear jobs on startup. Persist retry deadlines instead of relying on in-memory timers.
- **Validation shortcuts:** Truthiness defaults, numeric coercion in the API, trimming stored input, or early-return validation can violate the contract.
- **UI races:** Overlapping polls can regress displa
[truncated]