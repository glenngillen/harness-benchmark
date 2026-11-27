The job tracker is implemented: the build passes, and both fixed suites pass (smoke 2/2, contract 5/5). I didn't commit anything; the changes are in the working tree.

**What changed**
- **`src/db.ts`**: opens the database and creates the schema (`jobs` and `heartbeats` tables), plus a `BEGIN IMMEDIATE` transaction helper.
- **`src/jobs.ts`** (new): job row mapping and all SQL, shared by server and worker.
- **`src/validation.ts`** (new): request validation. It collects every offending field into `fields`.
- **`src/server.ts`**: the full API, `/health`, and `GET /`. Idempotency lookup and insert share one transaction. SIGTERM closes the server and the DB.
- **`src/worker.ts`**: the polling loop, step-by-step progress, retries, a 1-second heartbeat, and graceful release of an in-flight job on SIGTERM.
- **`ui/index.html`**: the form and job list with every required `data-testid`. It polls every second.

**Checks I ran by hand** (on a free port, fresh database)
- Validation: unknown fields, string numbers, non-integer and out-of-range values, bad JSON, non-object bodies, wrong content type, bad `Idempotency-Key`, and whitespace-only input all return 400 with the right field names.
- Idempotency: replay returns 200 with the same job, a different payload returns 409, and the key survives a SIGKILL restart.
- Retries: `failAttempts: 2` completes on attempt 3, and `failAttempts: 3` ends `failed` with `attempts: 3` and `"transient failure"`.
- Progress is visible mid-run (`3/10` observed).
- Durability: SIGKILL of both processes during a 20-step job; after restart the job completes on attempt 2.
- Both processes exit on SIGTERM. Health reports `worker: up`.
- Served HTML contains the form and list test IDs. I did not run the page in a browser.

**Choices I made where the spec was open**
- **Crash recovery uses a 5-second lease.** Each step renews it. A running job whose lease lapses is requeued. A job killed mid-run therefore resumes after at most about 5 seconds.
- **A crashed attempt still counts toward `attempts`.** The restarted run is the next attempt, so `attempts` can exceed 3 for jobs with no simulated failures.
- **Retry delay is a fixed 500 ms** (within the 250 ms–2 s window).
- **Shutdown releases the in-flight job** to `queued` without marking it failed.
- **Request body is capped at 64 KB.** Larger bodies get a 400 with field `body`.
- **Error text** (for example `"must be an integer from 1 to 20"`) is my wording. Only the codes and field names are fixed by the spec.

**Things to be aware of**
- A process I did not start was already listening on port 3917. My first manual run hit that port and gave misleading results, so I reran on a random free port. I left that process alone.
- The untracked dotfiles and `scripts/` in the repo root were already there; I didn't touch them.