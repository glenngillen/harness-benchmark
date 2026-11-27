The job tracker is built and working. The build, the smoke checks (2/2) and the contract checks (5/5) all pass. I also ran a manual end-to-end test of invalid input, idempotency, the failure path, and killing the worker with `SIGKILL` mid-job, then restarting it.

**What I changed:**

- **`src/db.ts`**: creates the shared SQLite tables: a `jobs` table and a one-row `heartbeat` table. It also turns database rows into the job JSON shape the API returns.
- **`src/server.ts`**: implements every endpoint in the spec.
  - Validation collects every problem in one response, using `body` when the body as a whole is wrong.
  - Idempotency keys are unique in the database, so a key can never create a second job, even after a restart. Payloads are compared after defaults are filled in.
  - `/health` reports the worker as up only if its heartbeat is less than 3 seconds old.
  - The server shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Writes a heartbeat every 500 ms and checks for queued jobs every 200 ms, taking the oldest first.
  - Each step takes 100 ms and progress is saved after every step.
  - A failed attempt waits 500 ms and goes back to `queued`; after the third failure the job is `failed` with `"transient failure"`.
  - On startup, any job left `running` by a crashed worker is put back in the queue.
  - On `SIGTERM` it puts its current job back in the queue without using up an attempt, removes its heartbeat and exits.
- **`ui/index.html`**: the form, error region and job list with all the required `data-testid` attributes. It refreshes the list every 500 ms and updates existing rows rather than redrawing them.

**Choices you may want to revisit:**

- **Crash recovery:** an attempt that was cut short by a crash counts as an attempt. In my test, a 20-step job killed mid-run finished on attempt 2. The count never goes above 3.
- **Missing or wrong `Content-Type`:** the error lists both `body` and `Content-Type`, because the spec doesn't say which field name to use.
- **Number fields in the form:** they are plain text boxes, not number inputs, and browser validation is off. That way odd values like `"abc"` or `2.5` reach the API and get its validation errors.

Nothing is committed; the changes are in the four files above. There are also untracked files in the repo that I didn't create (`.bashrc`, `.vscode`, `scripts`, `.github` and others). I left them alone.