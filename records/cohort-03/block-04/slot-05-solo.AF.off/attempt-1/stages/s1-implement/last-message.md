The job tracker works. `npm run build` succeeds and both check suites pass (smoke 2/2, contract 5/5). I also ran some things by hand that the checks don't cover:
- **Crash recovery:** I killed the worker with `SIGKILL` partway through a 20-step job. `/health` went to `"worker":"down"`, and after a restart the job finished on attempt 2.
- **Failure path:** a job with `failAttempts: 3` ended `failed` with `"transient failure"` after 3 attempts.
- **Bad requests:** a missing `Content-Type`, a bad `Idempotency-Key`, an array body, whitespace-only input, non-integer and `null` numbers, malformed JSON, 405 and 404 all gave the right errors and field names.
- **Shutdown:** both processes exit with code 0 on `SIGTERM`.

I didn't test the browser page in a real browser. I haven't committed anything.

**What changed:**
- **`src/db.ts`:** creates the database tables on startup. There's a `jobs` table, where each idempotency key is unique so a key can never create two jobs, and a `heartbeat` table the worker writes to.
- **`src/server.ts`:** the full API, with validation, error responses, 404/405 handling and `/health`. Creating a job and checking its idempotency key happen in one transaction, so a key keeps working the same way after a restart.
- **`src/worker.ts`:**
  - Writes a heartbeat every 500 ms and takes the oldest queued job.
  - Each step takes 100 ms, saves progress, and renews a 2-second lease on the job.
  - A failed attempt goes back to the queue after 500 ms, and the third failure marks the job `failed`.
  - If the worker dies, the lease runs out and the job is picked up again within about 2 seconds of a restart.
  - On `SIGTERM` mid-job, it puts the job back in the queue to start fresh.
- **`ui/index.html`:** the form and job list with all the required `data-testid` attributes. It refreshes every 500 ms, sends numeric fields as numbers, and turns off browser form checks so the API's own errors (with field names) appear in `form-error`.

**Two behaviours you might not expect:**
- If the worker crashes mid-attempt, that attempt still counts. So a crash during attempt 3 can lead to an attempt 4 that completes, rather than the job being marked failed.
- A graceful `SIGTERM` mid-job works the other way: it takes back the attempt it had just started, so it doesn't count.

There are untracked files in the repo root (`.bashrc`, `.vscode`, `scripts`, and others) that I didn't create, and I left them alone.