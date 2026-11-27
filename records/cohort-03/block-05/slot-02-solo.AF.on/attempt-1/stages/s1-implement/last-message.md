The job tracker is built, and the build, smoke and contract checks all pass (2/2 smoke, 5/5 contract). Beyond those checks I tested a few things by hand:
- **Crash recovery:** I killed the worker with `SIGKILL` while a 20-step job was 9 steps in. After a restart the job completed about 4 seconds later, with `attempts: 2`.
- **Permanent failure:** a job with `failAttempts: 3` ended `failed` with `"transient failure"` and `attempts: 3`.
- **Errors:** I got the expected 400, 404 and 405 responses for bad requests.
- **Shutdown:** both processes exit cleanly on `SIGTERM`.

I haven't tried the browser page in a real browser yet.

**What I changed:**
- **`src/db.ts`**: creates the tables on startup: one for jobs, including the idempotency key and a copy of the submitted payload, and one for worker heartbeats. It also has the shared code that turns a database row into the job JSON.
- **`src/server.ts`**: all the endpoints, with the full validation rules. Each problem field is listed by name, using `"body"` or `"Idempotency-Key"` where those are the problem. Idempotency is enforced in the database: the payload is compared after defaults are applied, a reused key with the same payload returns 200, and a different payload returns 409. `/health` reports the worker as up if it has sent a heartbeat in the last 3 seconds.
- **`src/worker.ts`**: sends a heartbeat every 500 ms and picks up the oldest queued job that is ready to run. Steps take 100 ms each, progress is saved after every step, and a failed attempt is retried after 500 ms. If a running job belongs to a worker with no recent heartbeat, it goes back in the queue. That is how jobs survive a `SIGKILL`; restarting the worker is enough. On `SIGTERM`, the worker puts its current job back in the queue and exits.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. It refreshes every 500 ms, sends the numeric fields as numbers, and shows the API's error message and each offending field in the `form-error` alert.

**Two behaviours you might not expect:**
- **Attempt counting:** a job that was running when its worker died counts as a new attempt when it restarts. `attempts` never goes above 3; a crash during the third attempt re-runs the third attempt.
- **Recovery delay:** after a hard kill, a running job waits up to 3 seconds before it is picked up again, until the dead worker's heartbeat goes stale. That fits within the 10-second limit.

I haven't committed anything; the changes are saved in the working tree.