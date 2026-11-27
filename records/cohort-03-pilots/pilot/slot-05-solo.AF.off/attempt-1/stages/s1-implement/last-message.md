The job tracker is built and working. `npm run build` compiles cleanly, and both bundled check suites pass: smoke 2/2 and contract 5/5.

**What I changed**
- **`src/db.ts`**: opens the database and creates the tables if they don't exist. There is a `jobs` table and a `worker_heartbeat` table. An idempotency key is stored with the job and is unique in the database, so it can only ever create one job, even across restarts. It also turns jobs into the required JSON shape.
- **`src/server.ts`**: all the API routes, the field validation, and the idempotency handling (`200` for a repeat, `409` for a conflict). It returns `404 not_found` and `405 method_not_allowed` for bad routes, and `/health` reads the worker's heartbeat. It shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**: writes a heartbeat every 0.5 s and checks for queued jobs every 150 ms, taking the oldest first. Each step takes 100 ms and progress is saved after every step. Failed attempts go back to `queued` and retry after 500 ms; after the third failure the job is marked `failed`.
- **Crash recovery**: a running job holds a 3-second lease that is renewed at each step. If the worker is killed, the lease runs out and the restarted worker picks the job up again.
- **`ui/index.html`**: the form, error region and job list with all the required `data-testid`s. It refreshes every 0.5 s. Number fields are sent as numbers, and browser validation is turned off so the API's error messages, including field names, appear in `form-error`.

**Manual tests**
- **Crash recovery:** I killed the worker with `SIGKILL` partway through a 20-step job. After restarting the worker, the job finished with `attempts: 2`.
- **Permanent failure:** a job with `failAttempts: 3` ended `failed`, with `"transient failure"` and `attempts: 3`.
- **Validation:** a bad `Idempotency-Key`, unknown fields, wrong `Content-Type`, non-object bodies and out-of-range values were each rejected with the right field named.
- **Shutdown:** both processes exited cleanly on `SIGTERM`.

**Behaviour you might not expect**
- If the worker crashes during a job's third attempt, the attempt is run again but `attempts` stays at 3, so it never goes above the 3-attempt limit.
- If the worker is stopped normally while a job is running, it puts the job back in the queue and doesn't count that attempt.
- Besides `application/json`, the server also accepts `+json` content types such as `application/merge-patch+json`.

I haven't committed anything; the changes are saved in the working tree.