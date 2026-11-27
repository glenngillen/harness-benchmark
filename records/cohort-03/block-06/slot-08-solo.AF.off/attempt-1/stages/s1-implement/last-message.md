The job tracker is built and works. `npm run build`, the smoke check (2/2) and the contract check (5/5) all pass. I couldn't commit because git has no author name or email set in this environment, and I didn't set one for you. All the changes are saved in the working tree under `src/` and `ui/`.

**What I changed**
- **`src/db.ts`**: creates the database tables, including a unique column for the `Idempotency-Key` so a key can never create two jobs, even across server restarts. It also converts a database row into the job JSON shape.
- **`src/server.ts`**: the full API.
  - `/health` reports the worker as "up" only if it wrote a heartbeat in the last 3 seconds.
  - Job submission validates the request and collects every offending field into one `400` response.
  - Idempotency compares the payload after defaults are applied: same payload returns `200` with the original job, a different one returns `409`.
  - Unknown paths return `404` and wrong methods return `405`. The server shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**: writes a heartbeat every 500 ms and picks up the oldest queued job every 100 ms. Each step takes 100 ms and progress is written after each one. A failed attempt goes back to `queued` and is retried after 500 ms, and after the third failure the job is marked `failed` with `"transient failure"`. On startup, any job left `running` by a dead worker is queued again. On `SIGTERM` it stops and closes the database.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. It checks for updates every 500 ms and changes items in place. The form turns off the browser's own validation so that bad values reach the API and its errors appear in the `form-error` box, with each field named.

**Tested by hand:** a job with `failAttempts: 3` ended `failed` after 3 attempts. I killed the worker with `SIGKILL` halfway through a 20-step job, restarted it, and the job finished. `/health` showed the worker as down while it was dead. The validation cases I tried (wrong content type, non-object body, bad key, non-integer steps) and the `404`/`405` responses all gave the right errors.

**Choices the spec didn't settle:**
- **Retry count after a crash:** the interrupted run counts as an attempt, so the job above finished with `attempts: 2`. If a worker dies during the third attempt, that attempt is re-run as attempt 3 rather than going over the 3-attempt limit. In that case `attempts` briefly drops back to 2 before the re-run starts.
- **Missing or wrong `Content-Type`:** the error lists both `"Content-Type"` and `"body"` in `fields`, since the spec doesn't say which name to use.