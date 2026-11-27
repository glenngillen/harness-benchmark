The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass. I did not commit anything.

**What changed** (only under `src/` and `ui/`; the fixed files and `checks/` are untouched):
- `src/jobs.ts` (new): job types, strict validation that collects every field error, the `Idempotency-Key` check, and the API error type.
- `src/db.ts`: schema creation (`CREATE TABLE IF NOT EXISTS`, run by either process), prepared statements, `BEGIN IMMEDIATE` transactions, the job serializer, and the heartbeat table.
- `src/server.ts`: routing, JSON body reading (case-insensitive `application/json` with parameters allowed), job endpoints, health, `/` serving the page, and a bounded `SIGTERM`/`SIGINT` drain.
- `src/worker.ts`: sequential loop, retries, progress writes, heartbeat every 500 ms, and clean shutdown that leaves an interrupted job `running`.
- `ui/index.html`: the form and list with all required `data-testid`s. It is built with DOM methods and `textContent`, polls every 500 ms without overlap, and shows rejections in `form-error`.

**Choices I made where the task was open:**
- **Interrupted attempts:** on restart, a `running` job is re-run from zero with its persisted attempt number. Recovery does not add an attempt, and a crash never turns into a transient failure.
- **Retry delay:** 500 ms. **Step time:** 100 ms.
- **Blank or non-numeric steps/failAttempts in the form:** sent as text, so the API rejects them instead of applying a default.
- **Idempotency:** one `BEGIN IMMEDIATE` transaction does the lookup and insert. A `UNIQUE` index on the key backs it up in SQLite.

**Verification beyond the fixed checks:** I wrote a temporary end-to-end script outside the repo and ran it on a fresh database. Everything passed:
- retries for `failAttempts` 0, 1, 2, 3, and 5, with correct attempt counts and the exact `transient failure` error;
- validation, including no job created on rejection;
- idempotency, including 8 concurrent same-key requests yielding one job;
- routing and 405s;
- observed running and intermediate progress;
- restart after `SIGKILL` keeping the same idempotent ID and completing a queued job;
- health going `down` after the worker is killed;
- a clean server `SIGTERM` exit.

I also sent `SIGTERM` to the worker mid-job. It exited in about 58 ms, the job stayed `running`, and the restarted worker finished it.

**Not verified:**
- **Browser behavior:** no browser is available here, so the page was only syntax-checked and reviewed by reading. Its rendering and the 2-second update behavior are untested.
- **Ports:** port 3917 was held by a process I could not see from the sandbox. My first run against it gave misleading results, so I left that process alone and reran on port 4917.