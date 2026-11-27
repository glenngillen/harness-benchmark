The job tracker is implemented in `src/` and `ui/`. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I also tested the cases the checks don't cover, by hand.

**What I changed** (uncommitted, in the working tree)
- **`src/db.ts`**: opens SQLite in WAL mode and creates the `jobs` and `heartbeats` tables. Both processes run this at startup, and every statement is idempotent. Also holds the job-shape mapper.
- **`src/server.ts`**: the HTTP API, the `/` page, and the health check. Validation collects every offending field. The idempotency lookup and insert run in one `BEGIN IMMEDIATE` transaction, and the key is a `UNIQUE` column so it survives restarts. Shuts down on SIGTERM/SIGINT.
- **`src/worker.ts`**: polls every 200 ms for the oldest eligible queued job and runs one attempt at a time. Each step is 100 ms and writes progress. Failed attempts retry after 500 ms, and the third failure marks the job `failed`. Writes a heartbeat every second and deletes it on clean exit. On startup, any job left `running` goes back to `queued`.
- **`ui/index.html`**: the form and list with all required `data-testid`s. It polls `/api/jobs` every second and shows API rejections, with each field name, in `form-error`.

**Verified by hand**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- A replayed `Idempotency-Key` returns 200 with the same job, and a different payload returns 409.
- Unknown fields, numeric strings, bad JSON, a wrong Content-Type, and a bad key each return 400 with the right `fields`.
- Wrong methods return 405 with an `Allow` header, and unknown paths return 404.
- SIGKILL of the worker mid-job, then a restart, completed the job on attempt 2 with no duplicate.
- SIGTERM stops both processes cleanly.

**Choices I made where the spec was open**
- A missing or wrong Content-Type, malformed JSON, and a non-object body all report the field `"body"`. A bad Idempotency-Key reports `"Idempotency-Key"`.
- An unknown field is reported under its own name.
- A retry delay of 500 ms, and a 64 KB body limit that returns 400.
- On a graceful stop, a running job goes back to `queued`. Its `attempts` count stays incremented, since the spec defines it as attempts started.

Nothing is committed. Say if you want a commit.