The job tracker is built: the server, the worker and the browser page all work. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) pass. I didn't commit anything; the changes are saved in the working tree.

**What I changed**
- **`src/db.ts`**: creates the parent folder if needed and sets up a `jobs` table and a single-row `heartbeat` table. Each job records an idempotency key, which can only be used once, and its payload after defaults are applied. It also has a lease time, so a job left `running` by a dead worker can be picked up again.
- **`src/server.ts`**: implements every endpoint in the task.
  - Validation reports each bad field, including `body` and `Idempotency-Key`.
  - Idempotency compares the payload after defaults. A same-key replay returns 200, a different payload returns 409, and the database rejects a second job for the same key, even after a restart.
  - Jobs are listed newest first.
  - `/health` reports the worker as `up` only if its heartbeat is less than 3 seconds old.
  - It shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Writes a heartbeat every 500 ms and checks for jobs every 100 ms.
  - Claims the oldest runnable job inside a database transaction, so only one claim succeeds at a time.
  - Each step takes 100 ms and saves its progress.
  - A failed attempt goes back to `queued` and is retried after 500 ms; after 3 attempts the job ends `failed` with `"transient failure"`.
  - On `SIGTERM` it puts the current job back in the queue and removes its heartbeat, so `/health` shows `down` straight away.
  - A job left `running` by a killed worker is picked up again about 3 seconds after its last step.
- **`ui/index.html`**: the form, error area, and job list with all the required `data-testid` attributes. The page refreshes every 500 ms. The numeric fields are plain text boxes: numbers are sent as numbers, anything else is sent as typed, so the API's error, naming the field, appears in `form-error`.

**Manual tests**
- Killing both processes with `SIGKILL` in the middle of a 20-step job: after restarting, the job was still there and completed on attempt 2.
- `failAttempts: 3` ended `failed` after 3 attempts.
- Bad requests got the right error responses: wrong or missing content type, non-object body, a bad idempotency key, a wrong method (405) and an unknown path (404).

**Behaviour you might not expect**
- An interrupted attempt still counts toward `attempts`, but `attempts` never goes above 3. So if the worker is killed during attempt 3, that attempt is rerun rather than starting a fourth.