The job tracker is implemented and builds. `npm run check:smoke` passes 2/2 and `npm run check:contract` passes 5/5. I didn't commit anything.

**What changed**

- **`src/db.ts`**: Both processes open the same SQLite file in WAL mode with a busy timeout. The schema is created idempotently here: a `jobs` table with a unique idempotency-key column, and a `heartbeats` table.
- **`src/jobs.ts`** (new): The job type, row-to-JSON mapping, and request validation. Validation collects every offending field into one `400` response.
- **`src/server.ts`**: The HTTP API, serving `/` and `/health`. Job creation runs in an immediate transaction, so the idempotency check and insert are atomic. Health reports `worker: "up"` if the heartbeat is under 3 seconds old. The server shuts down on SIGTERM.
- **`src/worker.ts`**: Polls every 200 ms for the oldest available queued job. It writes a heartbeat every second and runs each step at 100 ms, saving progress after each one. Failed attempts are requeued with a 500 ms delay, and the third failure marks the job `failed`. On startup, any job left `running` is requeued. On SIGTERM, an in-flight job is requeued and the process exits.
- **`ui/index.html`**: The form and list with the required `data-testid` hooks. It polls `/api/jobs` every second and renders all text with `textContent`.

**Checks beyond the repo suites**

I ran a scratch script outside the repo. It confirmed:
- A job with `failAttempts: 3` ends `failed` with `attempts: 3`.
- Validation rejects the cases in the spec with the right field names.
- `404` and `405` responses are correct.
- Idempotent replay returns `200`, and a payload conflict returns `409`.
- A job killed mid-run with SIGKILL resumes and completes after the worker restarts.
- Health reports `down` while the worker is dead.
- An idempotency key still replays after a server SIGKILL.
- Both processes exit on SIGTERM.

**Choices you may want to review**

- A job that is recovered after a crash counts the interrupted attempt in `attempts`, so the next run is attempt 2 or more.
- A missing `Content-Type` is reported under the `body` field, and it shares that field with the "not valid JSON" message when the body is also unparseable.
- A request body over 64 KB returns `400 invalid_request` on `body`, not `413`.

**Not verified:** I could not open the page in a real browser. I only checked that its inline script parses.