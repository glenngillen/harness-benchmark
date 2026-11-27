The job tracker is implemented in `src/` and `ui/`. It builds, both check suites pass (smoke 2/2, contract 5/5), and an extra behaviour script I wrote (outside the repo) passes 47/47 against real processes. Nothing is committed.

**What changed**
- **`src/db.ts`**: `openDatabase` now creates the `jobs` and `worker_heartbeat` tables. It also has a `transaction()` helper (`BEGIN IMMEDIATE`), `rowToJob()`, and `nowIso()`.
- **`src/server.ts`**: a `node:http` router with validation (every bad field is collected into `fields`), idempotency inside a transaction, health from the heartbeat, the UI route, and JSON on every response, including 404, 405 and 500. It handles SIGTERM and SIGINT.
- **`src/worker.ts`**: a heartbeat every second, and crash recovery at startup. Claims are oldest-first in a `BEGIN IMMEDIATE` transaction, with progress written after each step. Retries use a `run_after` back-off of 500 ms. On SIGTERM the in-flight job is requeued and the process exits 0.
- **`ui/index.html`**: the form with `novalidate`, the `form-error` alert, and a list that polls every second. Job data is rendered with `textContent` only.

**A race I found and fixed**
The first smoke run failed. The worker died at startup with `database is locked` while the server was creating the same fresh database. `busy_timeout` doesn't cover that case, so `openDatabase` now retries its idempotent init statements on `SQLITE_BUSY`. Fifteen cold starts with both processes launched together then all succeeded.

**Choices I made where the spec was silent**
- A job's `resume` flag re-runs an interrupted attempt under the same attempt number, so `attempts` never exceeds 3 after a crash.
- An oversize body (over 1 MB) is a `400 invalid_request` with field `body`, not a 413.
- The UI omits an empty numeric field so the server default applies. Non-numeric text is sent as a string so the API rejects it.

**Not verified**
I did not open the page in a real browser. I checked the required `data-testid` attributes and that the inline script parses, and the API behaviour it relies on passed the tests above.