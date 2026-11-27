The job tracker is built and working: the HTTP server, a separate worker process and the browser page. The build passes, as do both repo checks (smoke 2/2, contract 5/5). I couldn't commit, though: git has no author name or email set up here, and I didn't want to change your git config. The changes are saved and staged in `src/` and `ui/`, so you can commit them with your own identity.

**What I tested by hand beyond the checks:**
- `failAttempts: 3` ends `failed` with 3 attempts and the error `"transient failure"`.
- A 20-step job whose worker I killed with `SIGKILL` partway through went back to `queued` on restart and completed. All job data was still there.
- After restarting the server, sending the same `Idempotency-Key` again returned `200` with the original job.
- Wrong methods return `405` and a missing `Content-Type` returns `400`.
- Both processes exit with code 0 on `SIGTERM`.

I didn't test the browser page in a real browser.

**What changed:**
- **`src/db.ts`**: creates the database tables if missing and converts stored rows to the job JSON shape. Each idempotency key can belong to only one job, enforced by the database itself.
- **`src/server.ts`**: all the routes, error formats and validation from the spec. If a request has several problems, every offending field is listed. New jobs are created in a database transaction, so a key can't create two jobs.
- **`src/worker.ts`**:
  - Writes a heartbeat every second; `/health` reports `"up"` if it's under 3 seconds old.
  - Picks the oldest queued job; an idle worker checks for new jobs every 200 ms.
  - Each step takes 100 ms, and progress is saved after every step.
  - Failed attempts are retried after 500 ms, up to 3 attempts in total.
- **`ui/index.html`**: the form and job list with every required `data-testid`. It refreshes every 500 ms and shows each rejected field's name in `form-error`. The browser's own form validation is switched off, so bad values reach the API and its errors are shown.

**Two behaviours you might not expect:**
- **Interrupted jobs:** when the worker dies or is stopped during a job, it rolls back that attempt's count before running the job again. An interruption therefore doesn't use up one of the 3 attempts, and `attempts` never goes above 3.
- **Empty number fields:** if a number field in the form is left blank, it isn't sent, so the API uses its default.

Some files I didn't create are showing as untracked in the repo, such as `.bashrc`, `.vscode` and `scripts`. I didn't touch them.