Everything works and passes: `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5).

I also ran a few manual tests against a fresh database in a new folder:
- **Crash recovery:** I killed the worker with `SIGKILL` while a 20-step job was at 7/20 and restarted it. The job ran again from the start and completed.
- **Retry limit:** a job with `failAttempts: 3` ended `failed` with `"transient failure"` and `attempts: 3`.
- **Error responses:** unknown paths gave 404, wrong methods 405, and malformed requests 400 with the right fields listed.
- **Shutdown:** both processes exited cleanly on `SIGTERM`.

I did not test the browser page in a real browser.

**What changed**
- **`src/db.ts`**: creates a `jobs` table and a `heartbeat` table, and has one function that turns a database row into the job JSON shape.
- **`src/server.ts`**: implements all the endpoints and the validation rules from the task, and serves the page at `/`. Idempotency keys are unique in the database, so a key can't create a second job, even after a restart. `/health` reports the worker as up if its heartbeat is less than 3 seconds old.
- **`src/worker.ts`**: writes a heartbeat every 500 ms and checks for queued jobs every 100 ms, oldest first. Each step takes 100 ms and saves progress as it goes. Failed attempts wait 500 ms before retrying, up to 3 attempts.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. It refreshes every 500 ms and shows API errors, including each bad field's name, in the `form-error` box.

**Choices worth checking**
- **Interrupted attempts aren't counted.** When a worker dies mid-job, the restarted worker takes one off `attempts` and runs the job again. That means `attempts` can briefly go down, even though the task says it counts attempts "started so far". I did this so a crash can't push a job to a 4th attempt. The same happens when a worker gets `SIGTERM` mid-job.
- **Errors about the request as a whole are reported under `"body"`.** That includes a missing or non-JSON `Content-Type`, not a separate `"Content-Type"` field.
- **The step-count and fail-attempts fields have no browser limits.** The form skips the browser's built-in checks, so out-of-range numbers reach the API and its errors show on the page.

Nothing has been committed.