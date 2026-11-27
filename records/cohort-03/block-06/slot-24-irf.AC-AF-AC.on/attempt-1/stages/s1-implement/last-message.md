The job tracker is implemented. `npm run build` is clean, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What changed** (only `src/` and `ui/`):

- **`src/db.ts`**: the `jobs` and `worker_heartbeat` tables, created idempotently by both processes. It also has helpers for transactions, job mapping to the public JSON shape, and the worker-alive check.
- **`src/server.ts`**: the node:http API, with the routes, validation, error shapes, and idempotency. Key replay and insert run in one `BEGIN IMMEDIATE` transaction. Health reports `worker: up` only if the heartbeat is under 3 s old. SIGTERM closes connections and the DB.
- **`src/worker.ts`**: claims the oldest due queued job in a transaction, runs 100 ms steps with progress written after each, and applies the retry rules: a 500 ms back-off, 3 attempts total, then `failed` with `"transient failure"`. It writes a heartbeat every second. On startup it requeues any job left `running`. On SIGTERM it requeues the in-flight job and exits within about 200 ms.
- **`ui/index.html`**: the form and job list use the required `data-testid` values. It polls every second, builds the DOM with `textContent`, and shows API rejections, including field names, in `form-error`.

**Manual checks beyond the suites:**

- `failAttempts: 3` ends `failed` with `attempts: 3`.
- Malformed JSON, unknown fields, whitespace-only input, and a wrong Content-Type return `400` with the right `fields`.
- Unknown paths return `404`, and wrong methods return `405`.
- `kill -9` on the worker turns health to `worker: down`. After restart, the interrupted 20-step job completed and the same key replayed `200`. A different payload with that key returned `409`.
- SIGTERM stops both processes.

**Choices I made:**

- An interrupted attempt still counts toward `attempts`.
- Retry back-off is a fixed 500 ms.
- The request body is capped at 64 KB. A larger body is rejected as `body`.
- An empty `steps` or `failAttempts` field is sent as text, so the API rejects it rather than silently applying the default.

**Environment note:** during my first manual test, port 3917 was already held by a server I didn't start, and my `curl` calls hit it. I left that process alone and reran on a free port. Those first-run results were discarded.