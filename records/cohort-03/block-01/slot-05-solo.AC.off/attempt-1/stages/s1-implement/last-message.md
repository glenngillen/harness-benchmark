The job tracker is implemented. `npm run build` compiles cleanly, `check:smoke` passes 2/2, and `check:contract` passes 5/5. I did not commit anything.

**What changed**

- **`src/db.ts`**: opens the database with WAL and busy timeout, creates the schema (`jobs`, `idempotency`, `worker_heartbeat`), and creates the parent directory.
- **`src/jobs.ts`** (new): job types, the row-to-JSON mapping, and the constants (3 attempts, 100 ms steps, 500 ms retry delay).
- **`src/validation.ts`** (new): Content-Type, JSON-object body, unknown fields, types and ranges, and the `Idempotency-Key` format. Every offending field is listed.
- **`src/server.ts`**: the routes, the 404/405 handling, idempotency (the key and job commit in one `BEGIN IMMEDIATE` transaction), and health, which reports the worker as `up` if its heartbeat is under 3 s old.
- **`src/worker.ts`**: claims the oldest due job inside `BEGIN IMMEDIATE`, runs steps and updates progress after each one, and handles retries and failures. It writes a heartbeat every second and requeues interrupted `running` jobs on startup and on SIGTERM.
- **`ui/index.html`**: the form and the job list, with the required `data-testid` attributes. It polls `/api/jobs` every second.

**Choices I made where the spec was silent**

- A crashed or interrupted attempt still counts toward `attempts`. If the interrupted attempt was the third, the rerun takes that attempt number instead of exceeding three.
- Retry delay is a fixed 500 ms.
- Explicit `null` for `steps` or `failAttempts` is a validation error, not a default.
- The form sends numeric-looking text as numbers and everything else as text, so the server does the rejecting. Empty steps or fail-attempts fields are omitted, so defaults apply.
- Only one worker is supported. Startup recovery requeues every `running` job, so a second concurrent worker would take over live jobs.

**Verification beyond the fixed checks**

I ran a throwaway script in `$TMPDIR` against a live server and worker on a free port. It covered the validation edge cases, routing, and idempotency including the 409 path. It also checked the retry outcomes: `failAttempts: 3` ends failed after 3 attempts, and `failAttempts: 2` completes on attempt 3. SIGKILL of both processes mid-job recovered: the job resumed and completed, and the same idempotency key replayed the same job after restart. Graceful SIGTERM exits cleanly.

**Not verified**

- I did not load the UI in a browser. I only checked that the inline script parses and that the `data-testid` attributes are present.
- While starting my first test server, port 3917 was already held by a process I did not start. It is serving a different job database. I left it alone and used a free port for my tests.