The job tracker is implemented. Both fixed check suites pass (smoke 2/2, contract 5/5), and `npm run build` is clean.

**What I changed** (only under `src/` and `ui/`; nothing fixed or under `checks/` touched; no dependencies added; nothing committed):

- **`src/jobs.ts`** (new): shared types, and `validateSubmission`, which collects every field error (unknown fields, wrong types, ranges, whitespace-only input, bad `Idempotency-Key`, bad content type, malformed or non-object JSON) before any database access.
- **`src/db.ts`**: opens the database with the existing `busy_timeout`-then-WAL ordering, creates the schema idempotently in a `BEGIN IMMEDIATE` transaction, and provides a rollback-safe transaction helper and the single `serializeJob` that produces the public shape.
- **`src/server.ts`**: routing with 404/405 handling, atomic create/idempotency in `BEGIN IMMEDIATE` (keys stored in SQLite, so they survive restarts), health from the worker heartbeat (fresh within 3 s), a JSON 500 fallback, and graceful `SIGINT`/`SIGTERM` shutdown with a grace period.
- **`src/worker.ts`**: polls every 100 ms for the oldest eligible job, claims it in a short transaction, runs 100 ms steps committing progress after each, and writes a 500 ms heartbeat. Retries persist a 500 ms `retry_at` deadline; the third simulated failure marks the job `failed`. A job left `running` by a crash resumes its same attempt number without an extra count. On `SIGTERM` it finishes the current attempt, clears the heartbeat, and exits.
- **`ui/index.html`**: the form with the required `data-testid`s, `novalidate` with a `role="alert"` error region, and a list that polls every 500 ms without overlapping requests. All user text goes in via `textContent`.

**Verified by hand on a temp database:**
- `failAttempts: 5` ends `failed` after 3 attempts with `"transient failure"`.
- Validation reports all offending fields together.
- Killing the worker mid-job with `SIGKILL` makes health show `worker: down` within 3 s. On restart the job resumes and completes with `attempts: 1`, and a replayed `Idempotency-Key` returns 200 with no new job.
- Simultaneous startup against a missing nested directory works, and both processes exit on `SIGTERM`.

**Not verified:**
- The browser UI was not exercised in a real browser; I only checked the markup.
- Concurrent same-key requests and a `SIGKILL` landing during the third successful attempt were not tested.

**Choices I made:**
- Retry delay is 500 ms.
- Bodies over 64 KiB are rejected as a `body` field error.
- The worker processes one job at a time and assumes a single worker process.