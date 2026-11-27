The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I did not commit anything.

**Changes**
- **`src/jobs.ts`** (new): job types, validation (unknown fields, type and range checks, string length, whitespace-only input, `Idempotency-Key` pattern) that collects every offending field.
- **`src/db.ts`**: schema created with `IF NOT EXISTS` from either process, a `BEGIN IMMEDIATE` transaction helper, prepared statements, the public job serializer, and idempotent job creation.
- **`src/server.ts`**: routing with JSON 404 and 405 (with `Allow`), the API, `/` serving the HTML, health based on a 3-second-old heartbeat, body reading with a 64 KiB cap, and graceful `SIGTERM` (2-second grace before closing stalled connections).
- **`src/worker.ts`**: heartbeat every 500 ms, one job at a time, 100 ms steps with durable progress, retries with a 500 ms `available_at` deadline, and a final `toUpperCase()`. Jobs left `running` after a crash are replayed without incrementing `attempts`. Shutdown leaves unfinished work running for recovery.
- **`ui/index.html`**: the form with all required test IDs, `novalidate`, and API rejections shown with each field name in an `role="alert"` region. The job list polls every 450 ms without overlapping requests.

**Checks I ran by hand**
- Validation, malformed bodies, and content-type rejections return the expected fields.
- Five concurrent requests with the same key produce one `201` and four `200`s. A changed payload returns `409`.
- `failAttempts: 3` ends `failed` with `attempts: 3`.
- Killing the worker with `SIGKILL` mid-job, then restarting it, completes the job with `attempts` still at 1.
- `SIGTERM` exits both processes in about 60 ms.

**Not verified**
- I did not drive the browser page in a real browser. The `data-testid` attributes are present, but the polling and form behaviour are unchecked.
- I did not test the exact retry window or restart timing against the spec's bounds.

**Choices to review**
- Retry delay is fixed at 500 ms, inside the 250 ms–2 s window.
- Repeated `Idempotency-Key` headers are joined and then rejected by the pattern.
- The worker also handles `SIGINT`.