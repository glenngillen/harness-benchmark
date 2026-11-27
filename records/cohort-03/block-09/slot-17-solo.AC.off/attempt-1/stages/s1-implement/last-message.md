The job tracker is implemented and builds. Both `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) pass. I also tested behaviour the fixed suites don't cover, using a scratch script outside the repo.

**What changed** (only `src/` and `ui/`; no fixed files touched)
- **`src/db.ts`**: opens the database with the existing pragmas, creates the schema idempotently, and provides a `transaction` helper using `BEGIN IMMEDIATE`.
- **`src/store.ts`** (new): all SQL for jobs, idempotency keys, and the worker heartbeat. Both processes use it.
- **`src/validation.ts`** (new): request validation. It reports every offending field in one 400 response.
- **`src/server.ts`**: routing with 404/405, Content-Type and JSON parsing, idempotency (201/200/409, key stored in the same transaction as the job), `/health` from the heartbeat, and clean SIGTERM/SIGINT shutdown.
- **`src/worker.ts`**: claims the oldest due job, runs steps of 100 ms with progress written after each, retries failed attempts after 500 ms, and fails the job after three attempts. On startup it requeues jobs left `running`, and it writes a heartbeat every second.
- **`ui/index.html`**: the form and job list with the required `data-testid`s, polling every second. It renders with `textContent` only.

**Verified by hand**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- `failAttempts: 2` completes on attempt 3, and progress is visible mid-run.
- Validation, 404, 405, and idempotent replay (200) and conflict (409) all return the specified codes.
- After SIGKILL of both processes, a restart finishes the interrupted job. Idempotency still works after the restart.
- Health reports `down` once the worker is killed. SIGTERM exits both processes cleanly.

**Choices I made where the spec was open**
- A job interrupted mid-attempt is requeued, and its next run counts as a new attempt. So `attempts` can exceed 3 if a crash hits a job that was already on a successful attempt. I did not add a cap on crash recovery.
- A blank `steps` or `failAttempts` field in the form is omitted, so the default applies. Non-numeric text is sent as a string so the API rejects it.

**Not verified**
- I did not test the page in a real browser. I checked that the served HTML has the test IDs and that the inline script parses.
- While testing, ports 3917 and 3942 were already held by a process outside this session. My first manual run hit that process, so I reran on port 4817. I did not touch the other process.