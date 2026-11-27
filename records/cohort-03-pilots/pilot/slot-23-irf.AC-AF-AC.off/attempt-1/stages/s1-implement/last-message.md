The application builds, both check suites pass, and the manual checks behave as specified. I did not commit anything.

## What changed

- **`src/db.ts`**: `openDatabase()` now also creates the schema (`jobs` and `heartbeats` tables, with an index on the queue). `CREATE ... IF NOT EXISTS` makes it safe for both processes to run at startup in either order.
- **`src/jobs.ts`** (new): shared constants, the row-to-API mapping, and request validation with defaults applied.
- **`src/server.ts`**: the HTTP API. It covers `/health`, `GET`/`POST /api/jobs`, `GET /api/jobs/:id`, `GET /`, and the 404/405 handling. Idempotency runs inside a `BEGIN IMMEDIATE` transaction, and the server closes cleanly on SIGTERM.
- **`src/worker.ts`**: claims the oldest queued job atomically and runs its steps, updating progress after each one. It handles the failure and retry rules, writes a heartbeat every second, and resets `running` jobs to `queued` on startup. On SIGTERM it requeues the current job and exits.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. It polls `GET /api/jobs` every second and shows API rejections, including the offending field names, in `form-error`.

## Verification

- `npm run build`: clean.
- `npm run check:smoke`: 2/2 pass.
- `npm run check:contract`: 5/5 pass.
- Manual runs: `failAttempts: 3` ends `failed` with `attempts: 3`. Invalid bodies, unknown fields, bad Content-Type, and bad Idempotency-Keys return 400 with the right field names. Unknown paths give 404 and wrong methods give 405. Idempotent replay returns 200 and a conflicting payload returns 409. A worker killed with `SIGKILL` mid-job is resumed on restart and completes. Both processes exit on SIGTERM.

## Choices you may want to check

- **Content-Type errors** use the field name `"Content-Type"`. The task doesn't specify one.
- **Retry delay** is a fixed 500 ms, which is inside the 250 ms–2 s window.
- **An attempt interrupted by a crash or shutdown** still counts toward `attempts`.
- **Request body** is capped at 64 KB. Larger bodies get a 400 on the `body` field.
- **The UI** was checked by reading it, not in a browser. The polling and form-error logic is untested in a real browser.