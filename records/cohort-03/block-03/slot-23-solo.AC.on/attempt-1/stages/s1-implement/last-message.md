The job tracker is built and both fixed check suites pass (smoke 2/2, contract 5/5). I also ran an end-to-end script covering the rest of the spec, and it passed, with one caveat below. Nothing is committed.

**What changed**
- `src/db.ts`: opens the database and creates the `jobs` and `worker_heartbeat` tables.
- `src/store.ts` (new): all SQL, shared by server and worker. Writes run in `BEGIN IMMEDIATE` transactions, so the two processes don't race on claims or idempotency keys.
- `src/validation.ts` (new): request parsing. Every problem in a submission is reported, not just the first.
- `src/server.ts`: routing, the job endpoints, `/health` with the 3-second heartbeat check, and the page at `/`.
- `src/worker.ts`: claims the oldest due job, runs steps with progress written after each, handles `failAttempts` retries with random 250–2000 ms delays, and writes a heartbeat every second.
- `ui/index.html`: the form and job list with the required `data-testid`s, polling every second.

**Choices I made where the spec was open**
- A job left `running` by a dead worker is requeued when the next worker starts. If it had already used all 3 attempts, it fails with `"transient failure"`. This assumes a single worker, which the spec implies.
- Empty form fields are omitted so the server's defaults apply. Non-numeric text is sent as typed, so the server's validation reports it.
- Header values are normalised before validation, so an empty `Idempotency-Key` is rejected rather than ignored.

**Verification**
- Checked by the scenario script: validation cases, default values, pickup latency (under 1 s), observable progress, `failAttempts` 2 and 3, idempotent replay and conflict, routing 404/405, persistence and no duplicates after a SIGKILL of both processes, reprocessing of an interrupted job, `worker: down` after a kill, and graceful SIGTERM.
- Not verified: I did not open the page in a real browser. The UI logic is checked only by reading the code.

The scenario script is in `$TMPDIR/e2e/`, outside the repo. Port 3917 was already in use by another process on this machine, so I ran that script on 4817.