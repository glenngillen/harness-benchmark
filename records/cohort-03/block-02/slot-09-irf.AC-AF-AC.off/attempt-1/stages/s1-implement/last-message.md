The job tracker is implemented in `src/` and `ui/`. `npm run build` succeeds, and both `check:smoke` (2/2) and `check:contract` (5/5) pass.

I also tested by hand: validation edge cases, routing, idempotent replay and conflict, persistence across a server restart, `failAttempts: 3` ending `failed`, and a worker `SIGKILL` mid-run. After restart, the job resumed and completed.

**What changed**
- `src/db.ts`: adds the schema (`jobs` and `heartbeats` tables) on top of the existing WAL and busy-timeout setup.
- `src/jobs.ts` (new): the shared store. Idempotent submission runs in one `BEGIN IMMEDIATE` transaction, so a key can't create two jobs. It also holds the claim, progress, complete, fail and requeue queries, plus worker heartbeat.
- `src/validation.ts` (new): request validation. It collects every offending field into one `invalid_request` response.
- `src/server.ts`: routes, error shapes, `/health`, and graceful `SIGTERM`.
- `src/worker.ts`: one job at a time, ~100 ms per step, simulated failures with a 500 ms retry delay, a 1 s heartbeat, and recovery of `running` jobs on startup.
- `ui/index.html`: the form and job list with the required `data-testid` attributes. It polls every second and renders with `textContent`.

**Judgment calls to review**
- **Crash during attempt 3:** the interrupted attempt still counts toward `attempts`, as the spec defines it. If the job has already used all three attempts when the worker restarts, it is marked `failed` with "transient failure" rather than run a fourth time. A job with `failAttempts: 2` that crashes during attempt 3 therefore fails, even though it would have succeeded.
- **Graceful shutdown mid-job:** the worker stops at the next step and leaves the job `running`. The next start recovers it.
- **Empty steps or failAttempts fields in the UI:** these are omitted from the request so the server defaults apply. Non-numeric text is sent as typed so the API rejects it.
- **Body size:** requests over 64 KB get a `400` on field `body`.
- **Port collision:** during my first manual run, port 3917 was already held by a process I can't see. My server failed to start, so those early responses came from that other process, and I ignored them. I left that process alone and reran on a free port.

**Not verified:** I have no browser here, so the page is only syntax-checked. Its rendering and the form flow are untested.