The job tracker is built. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I couldn't commit because git has no user name or email set here, and I didn't set one for you. The changes are saved and staged in `src/` and `ui/`. The repo also has untracked files I didn't create (`.bashrc`, `.github`, `scripts`, etc.), and I didn't touch them.

**What I changed**
- **`src/db.ts`**: creates the `jobs` table (insertion order, idempotency key with a uniqueness rule, retry time) and a one-row heartbeat table. It also turns database rows into the job JSON shape the task specifies.
- **`src/server.ts`**: all the API routes, with 404 for unknown paths and 405 for wrong methods.
  - Validation follows the task's rules and lists every bad field, using `body` or `Idempotency-Key` where those are the problem.
  - Idempotency compares the payload after defaults are filled in. Because the key must be unique in the database, one key can never create two jobs, even across restarts.
  - `/health` reports the worker as up only if its heartbeat is less than 3 seconds old.
  - The server shuts down cleanly on `SIGTERM`.
- **`src/worker.ts`**:
  - Heartbeat every 500 ms.
  - Picks up the oldest ready queued job, checking every 100 ms.
  - Each step takes 100 ms and progress is saved after each one.
  - Failed attempts are retried after 500 ms, up to 3 attempts in total, then the job is marked failed with `"transient failure"`.
  - On startup, any job left `running` is put back in the queue.
  - On `SIGTERM`, the current job is put back in the queue, the heartbeat is cleared, and the worker exits.
- **`ui/index.html`**: a form and job list with all the required `data-testid` attributes. The list refreshes every 500 ms, and API rejections show in `form-error` with each field's name. Numeric fields are sent as numbers; anything non-numeric is sent as typed so the API can reject it.

**Two choices you might not expect**
- **Interrupted attempts don't count.** When the worker dies or is stopped mid-job, that attempt is taken back off the count before the job is re-queued. This keeps the rule "attempt *n* fails if *n* ≤ `failAttempts`" consistent, and a crash can't push a job past 3 attempts.
- **The step-count fields are plain text boxes**, not number inputs, so invalid values reach the API and its error message is shown.

**Tested by hand** against a scratch database, with the results as expected:
- A worker killed with `SIGKILL` part-way through a 20-step job: after restart the job ran again and finished as `LONG` with attempts still at 1.
- `failAttempts: 3` ended `failed` after 3 attempts.
- `/health` showed `down` once the worker was killed.
- Malformed JSON, a non-object body, a missing Content-Type, a bad key, a whitespace-only input, 405 and 404 each returned the right error.
- Both processes exited cleanly on `SIGTERM`.