The job tracker is implemented. It builds, and both fixed check suites pass: smoke 2/2 and contract 5/5. I also ran the server and worker by hand on a scratch database for the cases the checks don't cover. Nothing is committed.

**What changed**
- **`src/db.ts`**: opens SQLite in WAL mode with a busy timeout and creates the `jobs` and `heartbeats` tables. It also maps rows to the job JSON shape.
- **`src/worker.ts`**: polls for the oldest eligible queued job every 200 ms and writes a heartbeat every second. It runs each step for 100 ms and saves progress after each step. Attempts with `n ≤ failAttempts` fail at the first step. Retries wait 250–2000 ms, and the third failure marks the job `failed`. On startup it requeues any job left `running`.
- **`src/server.ts`**: implements all routes, validation, idempotency (key and fingerprint stored in SQLite), 404/405 handling, and the `/health` worker check (heartbeat within 3 s). It shuts down on `SIGTERM`.
- **`ui/index.html`**: the form, error region, and job list, with every `data-testid` from the spec. It polls every second.

**Manual checks (scratch database)**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- `failAttempts: 2` completes on attempt 3.
- `kill -9` of the worker mid-job: after restart the job completes.
- Data and idempotency keys survive a server restart. A replay returns 200, and a different payload under the same key returns 409.
- Validation rejects whitespace-only input, non-object bodies, malformed JSON, numeric strings, out-of-range and non-integer values, unknown fields, and a bad `Idempotency-Key`.

**Choices where the spec was open**
- Content-Type problems, malformed JSON, and non-object bodies all report the field as `"body"`.
- A worker killed mid-attempt keeps that attempt in `attempts`, so the re-run counts as the next attempt.
- On a graceful stop, a running job is left as `running` and requeued on the next worker start.

**Not verified**
- I did not test the browser page in a real browser. I checked that `GET /` serves the HTML and read the script for correctness.
- Port 3917 was already occupied by a process I can't see from this shell. My first manual run failed on that port, and I reran on port 4731. I did not touch that process.
- The workspace has untracked dotfiles and a `scripts/` directory that I did not create. I left them alone.