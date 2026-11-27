The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. Changes are uncommitted in the working tree.

**What changed**
- **`src/db.ts`**: opens the database and creates the `jobs` and `heartbeats` tables. The existing WAL and busy-timeout settings are kept.
- **`src/store.ts`** (new): the SQLite operations both processes share. Claims and idempotent inserts run in `BEGIN IMMEDIATE` transactions, and the idempotency key has a UNIQUE index.
- **`src/validation.ts`** (new): request validation. It reports every offending field and treats the `Idempotency-Key` header as a field.
- **`src/server.ts`**: routing, `POST`/`GET` jobs, `/health` (worker is `up` if its heartbeat is under 3 s old), and SIGTERM/SIGINT shutdown.
- **`src/worker.ts`**: claims the oldest due job, runs the steps (100 ms each, progress written after each one), handles retries, writes a heartbeat each second, and requeues running jobs on startup.
- **`ui/index.html`**: the form, error region, and job list with the required `data-testid` attributes. It polls every second and builds the DOM with `textContent`.

**Verification**
- The fixed checks pass. I also ran a scratch end-to-end script outside the repo, and everything passed. It covered invalid inputs, `failAttempts: 3` ending as `failed`, 404/405 routing, idempotency replay and conflict, a SIGKILL of both processes mid-job with recovery to `completed` on attempt 2 within about 2.4 s, idempotency surviving a server restart, and clean SIGTERM exits.
- Idle pickup took about 200 ms in a separate latency test. One run in the scratch test took about 600 ms, which I did not reproduce.
- I checked the page script only for syntax. I did not load the page in a real browser.

**Choices I made where the spec was open**
- Retries wait a fixed 500 ms.
- A job whose worker died mid-attempt keeps its `attempts` count. Its re-run is counted as the next attempt, so after a crash the 3-attempt limit can be reached one attempt later than the spec's exact wording suggests.
- A graceful SIGTERM during a job requeues it at once, rather than leaving it `running`.
- Bad `Content-Type`, malformed JSON, and non-object bodies are reported under the field name `body`.
- The UI leaves `steps` and `failAttempts` prefilled with `5` and `0`. An empty field is omitted so the API default applies.