The job tracker is implemented in `src/` and `ui/`. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What I changed**
- **`src/db.ts`**: keeps the existing WAL/busy-timeout setup, switches to `synchronous = FULL`, and adds the schema (`jobs`, `idempotency_keys`, `worker_heartbeat`) and a `BEGIN IMMEDIATE` transaction helper.
- **`src/validation.ts`** (new): request validation. It collects every offending field and covers unknown fields, types, ranges, blank input, bad JSON, non-object bodies, missing or non-JSON Content-Type, and the `Idempotency-Key` pattern.
- **`src/jobs.ts`** (new): row-to-JSON mapping and job submission. The idempotency check and the insert share one transaction, so a key can't produce two jobs.
- **`src/server.ts`**: routes for `/health`, `/`, `/api/jobs` (GET/POST), and `/api/jobs/:id`, with 404 and 405 handling. Health reports the worker `up` when its heartbeat is under 3 seconds old. SIGTERM closes the server cleanly.
- **`src/worker.ts`**: polls for due queued jobs every 200 ms, runs one attempt at a time, and writes progress after each 100 ms step. Failed attempts are requeued with a 500 ms delay, and the third failure marks the job `failed`. Heartbeat is written every second. On startup, any `running` job is requeued. SIGTERM stops it between steps.
- **`ui/index.html`**: the form and job list with all the required `data-testid`s, polling every second. It builds the DOM with `textContent`, not `innerHTML`.

**Choices I made where the spec was open**
- An attempt interrupted by a worker crash still counts in `attempts`, since the spec defines `attempts` as attempts started. Crashes never change the outcome, because failing attempts fail at their first step and are instant.
- The retry delay is a fixed 500 ms.
- The UI sends numeric-looking text as numbers and sends other text as typed, so the API reports wrong types. Blank fields are omitted so the defaults apply.

**Verified by hand** against a live server and worker on a scratch database:
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- `failAttempts: 2` completes on attempt 3.
- The idempotency replay returns 200, a different payload returns 409, and a bad key returns 400.
- Malformed bodies, missing Content-Type, unknown fields, and mixed validation errors return the expected 400 field lists.
- 404 and 405 responses are correct.
- SIGKILL of the worker mid-job: after restart the job completes with `SLOW JOB`.
- SIGKILL of the server: jobs persist across restart.
- SIGTERM on both: both exit 0.

**Not verified**: I had no browser, so the UI is checked for syntax and test IDs only, not rendered behaviour. I also did not test SIGKILL during a retry delay.

**Note**: an earlier attempt on port 3917 got responses from a process I couldn't see in `ps`. Those responses did not match this code, so I discarded them and used port 4817 for the manual tests.