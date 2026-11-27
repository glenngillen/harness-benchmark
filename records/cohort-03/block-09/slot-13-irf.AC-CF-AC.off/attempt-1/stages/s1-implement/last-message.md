The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass. I also exercised the spec beyond those checks by hand, and it behaves as written.

**What I changed**
- **`src/db.ts`**: keeps the existing WAL and busy-timeout setup and creates the schema: `jobs` and `heartbeats` tables, with a unique index on the idempotency key.
- **`src/jobs.ts`** (new): shared job row mapping, the transactional submit with idempotency (`BEGIN IMMEDIATE`), and heartbeat read/write.
- **`src/server.ts`**: routing with 404 and 405 errors, body and header validation with field-level errors, the 201/200/400/409 responses, and `/health` driven by the worker heartbeat. Shuts down on SIGTERM and SIGINT.
- **`src/worker.ts`**: on startup, requeues jobs left `running` by a dead worker. It then claims the oldest eligible job, runs 100 ms steps with progress written after each step, and simulates transient failures with up to 3 attempts. It writes a heartbeat every second and clears it on shutdown. A SIGTERM mid-attempt returns the job to `queued` without counting that attempt.
- **`ui/index.html`**: the form and job list with every required `data-testid`. It polls every second and builds the DOM with `textContent`, so job input cannot inject HTML.

**Verification beyond the checks**
- Validation rejections, the 409 conflict, idempotent replay (200), 405, and 404 all returned the specified codes.
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- SIGKILL of both processes mid-job: after restart the job was requeued, completed once with `attempts: 2`, and the same idempotency key replayed the same job.
- SIGTERM stops both processes, and `/health` reports the worker down afterwards.
- The UI script passes a syntax check. I did not load the page in a browser.

**Choices I made**
- Retry delay is a fixed 500 ms, which is within the 250 ms–2 s range.
- Missing or non-JSON `Content-Type`, malformed JSON, and non-object bodies are reported with field `"body"`. Unknown fields are reported by their own name.
- Request bodies over 100 KB are rejected as `invalid_request`.
- Steps take 100 ms each, pickup polling is every 200 ms, and the heartbeat interval is 1 s.

**One incident:** on my first manual run, port 3917 was already held by a process I could not see, and my server failed to bind. Those early responses came from that other process, so I discarded them and reran everything on a free port. The results above are from my own code.