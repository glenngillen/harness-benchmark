The job tracker is implemented, and `npm run build`, `check:smoke` (2/2) and `check:contract` (5/5) all pass. I also checked the behaviour the fixed checks don't cover, by running the server and worker by hand.

**What changed** (only `src/` and `ui/`):
- **`src/db.ts`**: opens SQLite in WAL mode and creates the `jobs`, `idempotency_keys` and `worker_heartbeat` tables. Adds a `BEGIN IMMEDIATE` transaction helper.
- **`src/jobs.ts`** (new): validation rules, the public job shape, and the transient-failure constants.
- **`src/server.ts`**: all routes and error shapes, request validation, idempotency checked and inserted in one transaction, and health derived from the worker heartbeat (up if it is at most 3 s old). Handles SIGTERM and SIGINT by closing the server and database.
- **`src/worker.ts`**: writes a heartbeat every second. Requeues jobs left `running` by a dead worker, claims the oldest due job, runs 100 ms steps with progress written after each, retries failed attempts after 500 ms, and fails after three attempts. On SIGTERM it requeues an in-flight job and exits.
- **`ui/index.html`**: the form and job list with every required `data-testid`. It polls `/api/jobs` every second, shows API rejections with field names in `form-error`, and builds the DOM with `textContent`.

**Manual checks** (run with a fresh database):
- A job with `failAttempts: 3` ends `failed` with `attempts: 3` and the error `"transient failure"`. A job with `failAttempts: 2` completes on attempt 3.
- Wrong content type, non-object body, malformed JSON, unknown fields, a bad `Idempotency-Key`, and a whitespace-only input all return 400 with the right fields. Wrong methods return 405 and unknown paths return 404.
- Killing the worker with SIGKILL makes `/health` report `worker: down`. A job killed mid-run is requeued on restart and completes.

**Choices you might want to change:**
- A job interrupted by a crash keeps the attempt it had started, so its `attempts` goes up by one on re-run.
- The retry delay is a fixed 500 ms.
- The design assumes a single worker. Startup requeue would disturb a second concurrently running worker.
- Request bodies over 64 KB are rejected as an invalid body.
- In the UI, an empty steps or failAttempts field is sent as `""` and rejected by the API, rather than silently using the default.

**Environment note:** port 3917 was already in use by a process I did not start, so my first test server failed to bind and its responses came from that other process. I used a different port and left the other process alone. Background processes also don't survive past the end of a Bash call.