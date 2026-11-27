The job tracker is implemented in `src/` and `ui/`. `npm run build` passes, and both fixed suites pass (smoke 2/2, contract 5/5). I did not commit anything.

**Changes**
- `src/db.ts`: opens the database as before, and now creates the schema: a `jobs` table, a `worker_heartbeat` table, and an index.
- `src/store.ts` (new): job queries, the public job shape, idempotent create (check and insert in one `BEGIN IMMEDIATE` transaction), and the worker's claim, progress, completion, retry, and heartbeat operations.
- `src/validate.ts` (new): body parsing and validation. It reports every offending field, including unknown fields.
- `src/server.ts`: the HTTP API, the `/` page, and routing with 404, 405, and 400 errors. It shuts down on SIGTERM and SIGINT.
- `src/worker.ts`: a loop that picks the oldest due job, runs steps of 100 ms with progress written after each step, and applies the retry rules. It heartbeats every second and shuts down on SIGTERM and SIGINT.
- `ui/index.html`: the form and job list with the required `data-testid`s. It polls every second and shows API errors with field names.

**Choices I made**
- A job interrupted by a worker crash is requeued at worker startup. The interrupted attempt still counts toward `attempts`.
- The retry delay is a fixed 500 ms, which is within the 250 ms to 2 s range.
- On SIGTERM during a job, the worker exits and leaves the job `running`. The next start requeues it.
- Empty `steps` or `failAttempts` fields in the form are omitted, so the API defaults apply.

**Verification**
- Manual run against a fresh database: `failAttempts: 3` ends `failed` with `attempts: 3`, and `failAttempts: 2` completes on attempt 3. Idempotent replay returns 200, a different payload returns 409, and invalid bodies, Content-Type, JSON, and Idempotency-Key return the expected 400s. Wrong methods return 405 and unknown paths return 404.
- Killing the server with SIGKILL kept all jobs. Killing the worker mid-job with SIGKILL led to the job completing after restart.
- Health reports `worker: down` once the worker is stopped.
- The UI script passes a syntax check. I did not run it in a browser, so the page behaviour is unverified.
- One early run showed a restarted worker not heartbeating and a job stuck at 6/20. I could not reproduce it in three reruns of the same sequence, so I can't say what caused it.

**Other notes**
- Port 3917 was already in use by a process I did not start, so my first manual test hit that server instead of mine. I discarded those results and did not touch that process.
- The untracked files at the repo root (`.bashrc`, `.github`, `scripts`, and others) were there before I started. I did not create or change them.