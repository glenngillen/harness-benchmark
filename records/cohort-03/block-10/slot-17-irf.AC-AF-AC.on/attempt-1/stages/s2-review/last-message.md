# Review findings

I only read the code. I had no shell in this session, so I did not build the app, run it or run the `checks/` scripts. Everything required looks implemented: the API contract, validation, idempotency (safe under concurrent requests and across restarts), the retry rules, crash recovery and the UI test IDs. I found only edge-case defects.

1. [minor] src/worker.ts:22 — Crash recovery can push `attempts` above 3. If the worker is killed while attempt 3 is running, the startup reset puts the job back to `queued` without touching `attempts`. The next claim then raises it to 4 (`claimStmt`, line 25). That breaks "up to 3 attempts in total". Repeated kills during attempt 1 or 2 can also go past the limit.
   Evidence: `recoverStmt` only sets `status='queued', not_before_ms=0`. `claimStmt` always runs `attempts = attempts + 1` and never checks it against `MAX_ATTEMPTS`. In `runAttempt`, a job with `attempts=4 > fail_attempts` will "complete" with `attempts: 4`.
   Fix: pick one rule and apply it consistently. Either:
   - (a) In `recoverStmt`, decrement `attempts` so the interrupted attempt is re-run rather than counted, e.g. `attempts = MAX(attempts - 1, 0)`. Or:
   - (b) Add `AND attempts < 3` to the claim, and in recovery mark jobs with `attempts >= 3` as `failed` with `error='transient failure'`.

   (a) best matches "a running job is processed again".

2. [minor] src/worker.ts:87-92 — If a DB call throws partway through an attempt (`progressStmt`, `completeStmt`, `requeueStmt`, `failStmt`, e.g. `SQLITE_BUSY` after the 5 s busy timeout), the error is logged and the job stays `running` until the worker restarts. The UI and API then show it stuck.
   Evidence: the `catch` only logs and sleeps. Running jobs are only reset by `recoverStmt` at startup.
   Fix: in the `catch`, try to requeue the job (`UPDATE jobs SET status='queued', not_before_ms=? WHERE id=? AND status='running'`) so it is retried under the normal rules. Alternatively, reset stale `running` rows on every poll and not only at startup.

3. [minor] src/worker.ts:22 — Recovery sets `status='queued'` but leaves `completed` at its old value. Until the job is claimed again, the API and UI show a queued job with stale progress such as `3/5`.
   Evidence: `recoverStmt` does not touch `completed`. Only `claimStmt` resets it.
   Fix: add `completed = 0` to `recoverStmt`, and to `requeueStmt` for consistency.