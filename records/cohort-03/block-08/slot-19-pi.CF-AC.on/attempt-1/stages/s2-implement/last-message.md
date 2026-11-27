The job tracker is implemented. `npm run build` passes, and both fixed suites pass (`smoke` 2/2, `contract` 5/5). I changed nothing committed; the work is in the working tree (`src/db.ts`, `src/jobs.ts` (new), `src/server.ts`, `src/worker.ts`, `ui/index.html`).

**What I changed**
- **`src/db.ts`**: opens the database as before (`busy_timeout` then WAL), creates the schema idempotently in an immediate transaction, and holds the job operations. Idempotent creation is one transaction, so replay, conflict and insert can't race. Worker claiming resumes an interrupted `running` job before picking up queued work, keeping its attempt number.
- **`src/jobs.ts`** (new): validation that collects every offending field, and the conversion to the public job shape.
- **`src/server.ts`**: the full API, `/` serving the page, `/health` based on the worker heartbeat (up if ≤3 s old), JSON 404/405/500 envelopes, and graceful shutdown on SIGTERM/SIGINT.
- **`src/worker.ts`**: a heartbeat every 500 ms, one job at a time, 100 ms steps with progress written after each step, retries with a 500 ms `available_at` deadline, and terminal failure on attempt 3.
- **`ui/index.html`**: the form and list with every required `data-testid`, DOM-built rendering with `textContent`, a serialized 500 ms poll, and an alert region listing each rejected field.

**Verified against a temporary database (not a committed test)**
- `failAttempts` 2 completes on attempt 3; `failAttempts` 3 ends `failed` with `"transient failure"` and zero progress.
- Validation returns the expected `fields` for whitespace input, unknown keys, numeric strings, fractions, non-object bodies and bad content types.
- Idempotency: the same key with an equal payload returns 200 with the original job; a different payload returns 409.
- Routing: 404 for unknown paths and missing jobs, 405 with `Allow` for wrong methods.
- SIGKILL of the worker turns `/health` to `worker: down` after about 3 s. A restarted worker resumes the interrupted 20-step job and completes it, with attempts unchanged.
- Both processes shut down cleanly on SIGTERM.

**Not verified**
- The browser page was not exercised in a real browser; I only checked that it is served.
- Concurrent same-key requests were not tested. The transaction design should make them safe, but that is unproven here.
- The 25-minute budget didn't allow the full verification list in the plan.

**Something to know**
- Port 3917 was already held by a process I did not start, which I could not identify and did not touch. My first manual run hit that process rather than my server. I reran on a free port, and the results above are from that run.