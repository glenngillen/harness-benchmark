The job tracker is implemented in `src/` and `ui/`. The build passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What I changed**
- **`src/db.ts`**: opens the database with `busy_timeout` before WAL, creates the schema idempotently, and adds a `BEGIN IMMEDIATE` transaction helper.
- **`src/jobs.ts`** (new): job types, the public serialization, submission with idempotency, and worker state transitions (claim, progress, completion, transient failure, heartbeat).
- **`src/validation.ts`** (new): validates bodies and `Idempotency-Key` and reports every offending field.
- **`src/server.ts`**: routing with 404/405, the API, `/health` based on heartbeat age, the page, and a graceful SIGTERM/SIGINT shutdown.
- **`src/worker.ts`**: a heartbeat every 500 ms, one job at a time, a 100 ms step, retries 500 ms apart, and a stop flag that leaves an interrupted job `running` for recovery.
- **`ui/index.html`**: the form with all required `data-testid`s, a `role="alert"` error region, and a list rendered with `textContent`. It polls every 500 ms and discards stale responses.

**Checked by hand (fresh DB, free port)**
- Health reads `down` with no worker and `up` with one. After a worker SIGKILL it reads `down` within 3.5 s.
- Validation: multiple field errors, wrong content type, malformed JSON, and an empty `Idempotency-Key` all return the right field names.
- Idempotency: 201 then 200 on replay, and 409 on a changed payload.
- Retries: `failAttempts: 3` ends `failed` after 3 attempts with `transient failure`. `failAttempts: 2` completes on attempt 3.
- Durability: a worker SIGKILLed at 3/20 on attempt 3 resumes after restart with `attempts` still 3, then completes with `DURABLE JOB`.
- SIGTERM exits both processes.

**Choices and limits**
- Bodies over 64 KiB are rejected with `invalid_request` on `body`. The spec does not cover this case.
- Unknown routes return `404 not_found` with the message "No such route." Other 404s use "No such job."
- Not run: the browser page itself, which I did not load in a browser. I also did not run a SIGKILL during the first attempt, or simultaneous same-key requests.

**Incident to note:** my first manual test hit port 3917, where another process was already listening. My server failed to start with `EADDRINUSE`, so those responses came from that other process. I did not stop it. Its database is not in this repo, and I did not change it. The results above come from the second run on a free port.