The job tracker is implemented: the HTTP API, the browser page, the worker, and SQLite as the shared state. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass.

**What I changed** (only `src/` and `ui/`):
- `src/db.ts`: opens the database, creates the schema (a `jobs` table and a `heartbeats` table).
- `src/jobs.ts`: all SQLite reads and writes. Idempotent submission and job claiming run in `BEGIN IMMEDIATE` transactions.
- `src/validation.ts`: request validation, covering body shape, field rules, Content-Type, and the `Idempotency-Key` header.
- `src/server.ts`: routing, the JSON error shape, `/health` (worker is `up` if its heartbeat is under 3 s old), and the browser page at `/`.
- `src/worker.ts`: claims the oldest due job, runs one attempt at a time, writes progress after each step, retries transient failures, and writes a heartbeat every second.
- `ui/index.html`: the form and job list, using the required `data-testid` attributes. It polls `/api/jobs` every second.

**Choices I made where the spec left room:**
- Retry delay is a fixed 500 ms.
- An attempt interrupted by a crash or shutdown keeps its count in `attempts`, so the next attempt is numbered after it.
- On `SIGTERM`, the worker finishes the current step, returns the in-flight job to `queued`, clears its heartbeat, and exits. A `SIGKILL` leaves the job `running`, and startup requeues it.
- Problems with the body as a whole (missing or wrong Content-Type, malformed JSON, non-object body) are reported under the field `"body"`.

**Verified by hand against a fresh database:**
- A job with `failAttempts: 5` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- `failAttempts: 2` completes on attempt 3.
- Repeated idempotency keys return 201 then 200 with the same job, and a different payload returns 409.
- Validation rejects each case in the spec.
- Killing the worker mid-job with SIGKILL, then restarting it, completes the job on attempt 2 with progress 20/20. Jobs survive a server restart.

**Not verified:** I did not load the browser page in a real browser. I only checked that the page's script parses and that the API it calls behaves correctly. The UI is the part most worth a look by hand.

I did not commit anything. The untracked dotfiles and `scripts/` were already in the working tree before I started, so I left them alone.