The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass. I did not change any of the fixed files or anything under `checks/`, and I added no dependencies.

**What changed**

- **`src/db.ts`**: opens the database (keeps the existing WAL and busy-timeout settings) and creates the `jobs` and `heartbeats` tables.
- **`src/jobs.ts`** (new): shared constants and the row-to-JSON mapping.
- **`src/validate.ts`** (new): request validation. It collects every problem into `fields`.
- **`src/server.ts`**: the HTTP API, idempotent job creation in a single immediate transaction, and `/health` based on the worker heartbeat.
- **`src/worker.ts`**: claims the oldest eligible queued job, runs steps with progress updates, handles retries, writes a heartbeat every second, and requeues `running` jobs on startup and on shutdown.
- **`ui/index.html`**: the form with the required `data-testid`s, and a list that polls every second.

**What I checked by hand**

- Validation: string numbers, fractional steps, whitespace-only input, unknown fields, malformed JSON, non-object bodies, bad Content-Type, and bad Idempotency-Key all return 400 with the right field.
- Idempotency: same-key replay returns 200 with the same job, a different payload returns 409, and the replay still works after a restart.
- Retries: `failAttempts` 3 and 5 both end `failed` with `attempts` 3 and `transient failure`. `failAttempts` 1 completes on attempt 2.
- Durability: after `SIGKILL` of the worker mid-job, the job survives, `/health` reports `worker: down` after about 3 s, and the job completes once a new worker starts.
- Shutdown: both processes exit on `SIGTERM`.
- The UI inline script passes a syntax check. I did not load the page in a browser, so the rendering is unverified.

**Choices I made**

- Retry delay is a fixed 500 ms.
- A crashed attempt still counts toward `attempts`. If the worker dies during attempt 3 of a job, the recovered run is attempt 4.
- Unknown-field errors name the key itself. Problems with Content-Type or the body as a whole use the field `body`.
- Empty `steps` or `failAttempts` fields in the form are omitted, so the API defaults apply.
- Request bodies over 64 KB are rejected with `invalid_request`. The brief doesn't cover this case.

**Environment note**

My first manual test run hit port 3917, which another process already held. That process answered my requests, so I discarded those results and reran on a free port. I did not touch that process.