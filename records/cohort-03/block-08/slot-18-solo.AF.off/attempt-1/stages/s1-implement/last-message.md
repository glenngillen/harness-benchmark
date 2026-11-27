The job tracker is built. `npm run build` compiles cleanly, and the smoke checks (2/2) and contract checks (5/5) pass.

**What I changed:**
- **`src/db.ts`**: creates the database file and its folder, sets up a `jobs` table and a `heartbeat` table, and converts stored rows into the job JSON the API returns.
- **`src/server.ts`**: implements every route in the task, with the required error codes (404, 405, 400 with per-field errors, 409) and all the validation rules. An `Idempotency-Key` is stored as a unique column next to the payload with defaults filled in, so one key never creates two jobs, even after a restart. `/health` shows the worker as `up` when its last heartbeat is under 3 seconds old. The server shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Writes a heartbeat every 500 ms and removes it on shutdown.
  - Takes the oldest queued job, checking every 100 ms. Each step takes 100 ms and saves progress as it goes.
  - Failed attempts go back to `queued` and retry after 500 ms. After the third failure the job becomes `failed` with `"transient failure"`.
  - On startup it puts any job left `running` back in the queue. On `SIGTERM` it does the same for its current job.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. Numeric fields are sent as numbers, the alert region shows API errors with each field's name, and the list refreshes every 0.7 s.

**Manual test:** I also ran both processes by hand. I tried the validation edge cases and a wrong method on a known path. I killed the worker with `SIGKILL` in the middle of a 20-step job, and after a restart that job completed on attempt 2. A job with `failAttempts: 3` ended `failed` after 3 attempts. Both processes exited cleanly on `SIGTERM`.

**Choices you might want to revisit:**
- If the worker dies during a job's third attempt, the rerun doesn't increase `attempts`, so it never goes above 3.
- A wrong or missing `Content-Type` is reported under the field `"body"`.

I haven't committed anything. There are some untracked files in the repo (`.bashrc`, `.github`, `scripts`, and so on) that I didn't create, and I left them alone.