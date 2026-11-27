The job tracker is implemented. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I also tested the behaviour beyond those checks by hand.

**What changed** (only under `src/` and `ui/`; the fixed files and `checks/` are untouched, and nothing is committed):
- **`src/db.ts`**: opens the database (WAL, busy timeout), creates the `jobs` and `worker_heartbeat` tables, and adds a `transaction()` helper.
- **`src/jobs.ts`** (new): row types, the public job shape, and the queries.
- **`src/validation.ts`** (new): request validation. It collects every offending field, with defaults applied.
- **`src/server.ts`**: routes, 400/404/405/409 responses, idempotency keys enforced by a unique column inside a write transaction, and `/health` based on the worker heartbeat.
- **`src/worker.ts`**: claims the oldest eligible queued job atomically, updates progress after each 100 ms step, retries transient failures, and writes a heartbeat every second.
- **`ui/index.html`**: the form and job list with the required `data-testid`s. It polls every second and renders with `textContent`.

**Manual checks beyond the suites:**
- Validation rejects every case in the spec, including whitespace-only input, numeric strings, non-integers, unknown fields, malformed JSON, and a missing Content-Type.
- `failAttempts: 3` ends `failed` with `attempts: 3`. `failAttempts: 1` completes on attempt 2.
- Idempotency replays return 200 with the same job, a different payload returns 409, and a bad key returns 400.
- SIGKILL of both processes mid-job: on restart the job resumed and completed, and the idempotency key still replayed the original job.
- SIGTERM shuts down cleanly. An in-flight job goes back to `queued` with its attempt count undone.

**Choices I made:**
- A running job holds a 3-second lease that is renewed on every step. Any running job with a lapsed lease is requeued, which is how a killed worker's job gets picked up.
- Transient retries wait a fixed 500 ms.
- Request bodies are capped at 64 KB.
- A graceful stop counts as an attempt that never ran, so `attempts` is decremented. A SIGKILL counts as an attempt that ran.

**Not verified:** I did not directly observe `worker: "down"` after a SIGKILL. I only saw it after SIGTERM. The logic is a 3-second heartbeat threshold, but I did not test that path.

**Note:** when I first ran the manual tests, port 3917 was already held by a process I didn't start. Its responses were mixed into my test results, so I discarded them and reran everything on a free port. I left that process alone.