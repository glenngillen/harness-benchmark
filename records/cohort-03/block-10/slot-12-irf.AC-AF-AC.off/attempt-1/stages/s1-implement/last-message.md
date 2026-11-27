The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass, and I did not commit anything.

**What changed**
- **`src/db.ts`**: Opens SQLite in WAL mode and creates the `jobs` and `heartbeats` tables. It also maps stored rows to the public job shape.
- **`src/validation.ts`** (new): Validates submissions and reports every offending field, including unknown fields.
- **`src/server.ts`**: The HTTP API, the `/` page, and `/health`. Creation and the idempotency check run in one `BEGIN IMMEDIATE` transaction. A unique index on the key makes it hold across restarts. Routing returns `404` for unknown paths and `405` for wrong methods.
- **`src/worker.ts`**: Picks the oldest eligible job, runs one attempt at a time, and writes progress after each 100 ms step. It writes a heartbeat every second and clears it on shutdown. On startup it recovers jobs left `running` by a crash.
- **`ui/index.html`**: The form and job list with all the required `data-testid` hooks. It polls every second and sends numeric fields as numbers.

**Choices I made where the spec was open**
- A crash-interrupted attempt still counts in `attempts`, so a restarted job shows `attempts: 2` after one crash. The 3-attempt cap only counts transient failures.
- Retry delays are random in 250–1500 ms. I kept the upper bound under 2 s so that polling overshoot stays inside the limit.
- Repeated `Idempotency-Key` headers fail the pattern and return a 400.

**What I checked by hand**
- Validation, retries, and the failed state at `failAttempts: 3`.
- Idempotent replay (200) and conflict (409).
- Recovery after SIGKILL of the worker: the job completed after restart, and `/health` went `down` then `up`.
- Clean exit on SIGTERM.

**Not verified:** I did not load the UI in a browser. I only confirmed that the page is served and contains the required hooks. The job-level hooks are created by the script when a job appears, so they can't be seen in the raw HTML.