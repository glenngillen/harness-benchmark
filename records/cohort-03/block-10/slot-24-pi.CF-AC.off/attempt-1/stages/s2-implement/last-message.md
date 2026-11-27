The job tracker is implemented in the working tree. It builds, and both disclosed check suites pass (2/2 smoke, 5/5 contract). I did not commit anything.

**What I changed** (only under `src/` and `ui/`):
- **`src/db.ts`**: opens the database as before, sets `busy_timeout`, WAL, and `synchronous=FULL`, and creates the schema idempotently. It holds all persistence: idempotent submit under `BEGIN IMMEDIATE`, job claiming, progress and completion updates, failure/retry transitions, and the worker heartbeat.
- **`src/jobs.ts`** (new): constants, validation that collects every field error, canonical payloads for replay comparison, and the public job serializer.
- **`src/server.ts`**: routing by pathname, JSON error envelopes (including for malformed HTTP), submission and idempotency, health, and a bounded graceful drain on SIGTERM/SIGINT.
- **`src/worker.ts`**: 500 ms heartbeat, a 100 ms poll, one job at a time, progress committed after each step with no transaction held during waits, simulated failures with a 500 ms retry deadline stored in SQLite, startup-only recovery, and shutdown that leaves unfinished work open for replay.
- **`ui/index.html`**: the required `data-testid` hooks, `role="alert"` error region, `textContent` rendering, and serialized 500 ms polling.

**Verification**
- `npm run build`, `npm run check:smoke`, and `npm run check:contract` all pass.
- I wrote a 48-check probe in `$TMPDIR`, outside the repo, against the built app. It passed 48/48. It covered:
  - validation and routing edge cases;
  - `failAttempts` 0 through 5;
  - observable intermediate progress and Unicode uppercasing;
  - concurrent idempotent submits and replay after a server restart;
  - SIGKILL of the worker mid-job, with health going down within 3 s and the job completing after restart without double-counting the attempt;
  - SIGTERM exits for both processes.

**Choices I made**
- Recovery replays an interrupted attempt with its attempt number kept. A job killed during attempt 3 therefore gets at most one more attempt-3 run and cannot exceed three attempts.
- Request bodies over 64 KiB are rejected with a `body` field error.
- Duplicate `Idempotency-Key` headers are rejected, not resolved by picking one copy.
- Health is `up` only when the heartbeat row exists and is at most 3 s old. A clean worker shutdown deletes the row.

**Not verified**
- I did not run the page in a real browser. I checked that its inline script parses, but the DOM behaviour (the 2 s update requirement, form reset, and error rendering) is unverified in a browser.
- I did not separately test a worker kill during a retry wait, though the logic path is the same persisted-deadline path that the restart test covers.