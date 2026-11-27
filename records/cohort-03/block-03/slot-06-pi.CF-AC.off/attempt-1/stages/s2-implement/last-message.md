The job tracker is implemented, builds, and passes both fixed check suites (smoke 2/2, contract 5/5). I didn't commit anything.

**Changed files** (only `src/` and `ui/`; the fixed files and `checks/` are untouched):
- `src/db.ts`: opens the database, keeps the busy timeout before WAL, and creates the schema idempotently. Adds a short `BEGIN IMMEDIATE` transaction helper and the job and heartbeat queries.
- `src/jobs.ts` (new): request validation, canonical payload for idempotency, and the public job serialization.
- `src/server.ts`: routing, body reading, idempotent creation, listing, lookup, health, and a graceful `SIGTERM`/`SIGINT` shutdown.
- `src/worker.ts`: sequential processing with 100 ms steps, progress persisted after each step, retries at 500 ms, recovery of `running` rows, a 500 ms heartbeat, and clean shutdown.
- `ui/index.html`: the form with every required `data-testid`, a polling job list, and `textContent`-only rendering.

**Choices I made:**
- An interrupted `running` job resumes with its existing attempt number. Recovery does not add an attempt.
- Numeric form fields that don't parse are sent as their raw text, so the API rejects them rather than the form substituting a default.
- Bodies over 64 KiB are rejected with a `body` field error.

**Verified by hand** (on a free port with a fresh database):
- Validation returns every offending field at once.
- `failAttempts: 5` ends `failed` with `attempts: 3`.
- Replay returns 200, and a changed payload returns 409.
- A job killed mid-run with SIGKILL completes after restart.
- Health reports `down` within 3 seconds of the worker dying.
- 405 and 404 responses have the right shape.
- Both processes exit cleanly on SIGTERM.

**Not verified:**
- Browser behaviour; I checked the page only by serving it.
- Concurrent submissions with the same key, and the retry-delay timing beyond the contract check.
- The hidden evaluation's cases.

**Environment note:** while testing, port 3917 was already held by a process I didn't start. My first probe hit that process, not my server, so I discarded those results. I didn't touch that process.