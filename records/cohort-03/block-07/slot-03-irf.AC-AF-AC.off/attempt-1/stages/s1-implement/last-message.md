The job tracker is implemented. `npm run build` passes cleanly, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What changed** (all under `src/` and `ui/`; the fixed files and `checks/` are untouched):

- **`src/db.ts`**: opens SQLite in WAL mode with a busy timeout, creates the `jobs` and `worker_heartbeat` tables, and provides a write-transaction helper.
- **`src/jobs.ts`** (new): the job row type and the API job serialisation.
- **`src/validation.ts`** (new): body validation and defaults, and the `Idempotency-Key` pattern.
- **`src/server.ts`**: the HTTP routes, idempotency, `/health`, and the `/` page. It shuts down on SIGTERM and SIGINT.
- **`src/worker.ts`**: claims the oldest ready job in a transaction, runs steps of 100 ms with progress written after each step, and applies the retry rules. It writes a heartbeat every second, requeues interrupted running jobs at startup, and shuts down on SIGTERM and SIGINT.
- **`ui/index.html`**: the form and job list with the required `data-testid` attributes. It polls `/api/jobs` every second.

**Choices I made where the spec was open:**

- Retry delay is a fixed 500 ms.
- On a graceful SIGTERM in the middle of a job, the worker requeues it and gives back the attempt it had started, so it restarts from step 0 with the same attempt number.
- After a SIGKILL, the interrupted attempt stays counted in `attempts`, since it did start.
- Validation collects every offending field in one 400 response, so a bad `Idempotency-Key` and a bad body are reported together.
- The page sends `steps` and `failAttempts` as numbers when the text is numeric and as the raw text otherwise, so the server rejects bad values. Empty fields are omitted, which means the defaults apply.

**What I verified by hand:** a retry sequence (`failAttempts: 2` completes on attempt 3), idempotent replay (201, then 200, then 409 on a different payload), the validation and routing error codes, SIGTERM shutdown of both processes, and SIGKILL of the worker mid-job followed by a restart, which completed the job.

**Not verified:** I did not open the page in a browser, and I did not directly check that `/health` reports `worker: "down"` after the worker stops. The page script passes a syntax check only.