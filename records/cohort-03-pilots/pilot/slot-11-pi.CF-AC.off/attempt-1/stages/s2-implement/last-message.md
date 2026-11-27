The job tracker is implemented in `src/` and `ui/`, and it builds. `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) pass. I did not commit anything.

**What changed**
- `src/db.ts`: schema creation (`IF NOT EXISTS`, safe to run from either process), WAL with `synchronous = FULL`, and a `BEGIN IMMEDIATE` transaction helper.
- `src/validation.ts` (new): collects all body and `Idempotency-Key` errors into one `fields` list.
- `src/jobs.ts` (new): job serialization, idempotent submission, the worker's claim/progress/retry/complete/fail transitions, and heartbeat reads.
- `src/server.ts`: explicit routing (404 and 405 with `Allow`), `/health`, the job endpoints, `/` serving the page, and `SIGTERM` shutdown with a 3 s drain.
- `src/worker.ts`: heartbeat every 500 ms, sequential processing with 100 ms steps, persisted retries with a 500 ms delay, and clean shutdown.
- `ui/index.html`: the required `data-testid` elements, `textContent` rendering only, and a 500 ms poll with one request in flight at a time.

**Probe results (fresh database, run by hand)**
- `failAttempts` 3 ends `failed` with `attempts: 3` and `error: "transient failure"`.
- Multiple validation errors come back together. Bad content type, non-object bodies, malformed JSON, and an empty `Idempotency-Key` each return 400 with the right field.
- Idempotent replay returns 200 with the same ID. A conflicting payload returns 409.
- A worker killed with SIGKILL mid-attempt resumed the job on restart, keeping its attempt number. It completed with the correct output.
- After `SIGTERM`, the heartbeat is gone, both processes exit, and `/health` no longer answers.

**Choices I made**
- A job interrupted while `running` resumes from step zero with its attempt number unchanged, as the plan said. A crash therefore doesn't use up an attempt.
- The retry delay is a fixed 500 ms, which is inside the 250 ms–2 s window.

**Not verified**
- I have no browser here, so the page is only checked by a syntax parse of its script. Rendering, the 2-second refresh, and the error display still need a real browser check.
- I did not run the worker-stopped ordering scenario or the concurrent same-key test.