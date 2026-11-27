The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass.

**Changes**
- **`src/db.ts`**: opens the database, creates the parent directory, and runs idempotent `CREATE ... IF NOT EXISTS` schema setup. Also has a `BEGIN IMMEDIATE` transaction helper and heartbeat read/write.
- **`src/jobs.ts`** (new): job types, the public serializer, and request validation. Validation collects every error, and the idempotency key check is included.
- **`src/server.ts`**: routing with 404/405 errors, creation and idempotent replay in one transaction, a `UNIQUE` index on the key, health from the stored heartbeat (up if ≤3 s old), and graceful SIGTERM/SIGINT shutdown.
- **`src/worker.ts`**: oldest-first claiming with retry eligibility, per-step progress writes, final-step completion committed together, 500 ms retry back-off, a 500 ms heartbeat, recovery of interrupted `running` jobs under their existing attempt number, and clean shutdown.
- **`ui/index.html`**: the required test IDs, `novalidate` form, `textContent` rendering, serialized 500 ms polling, and errors shown in `form-error`.

**Verified by hand on a temporary database**
- Validation errors name the offending fields, and a bad `Idempotency-Key` is rejected.
- Idempotent replay returns 200, a changed payload returns 409, and a replay after restart returns the original job.
- `failAttempts` 2 completes on attempt 3, and `failAttempts` 3 ends `failed` with `transient failure`.
- Routing: wrong methods return 405, unknown paths return 404, and `/` serves the page.
- After SIGKILL of both processes, the jobs survived the restart. Health reported `down` while the worker was stopped, and `up` again afterwards.
- A worker killed mid-way through a successful third attempt resumed it, completed it, and kept `attempts` at 3.

**Not verified**
- I did not test the page in a real browser, so the form, error display, and live updates are untested.
- I did not run concurrent same-key requests to check the single-row guarantee. The transaction serializes them within the server process, so I expect it to hold.
- I did not test SIGTERM during an active job, only that both processes exit cleanly when idle.

**Choices I made**
- Retry back-off is a fixed 500 ms.
- Body size is capped at 64 KB; larger bodies get a `400` on the `body` field.
- Nothing was committed, as you did not ask for a commit.