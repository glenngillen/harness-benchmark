# Review findings

1. [major] src/worker.ts:24-34 — When a lease expires and the job is reclaimed, `attempts` is incremented with no cap. A job can end up with more than 3 attempts. With `failAttempts` ≥ 3 it can also end `failed` with `attempts` 4 or more, but the spec requires exactly 3.
   Evidence: `claimJob` always does `attempts = attempts + 1` and does not check `MAX_ATTEMPTS`. Example: `failAttempts: 2`. Attempt 3 is running when the worker is SIGKILLed (or SIGTERMed, since line 89 just returns and leaves the job `running`). On restart the job is reclaimed as attempt 4 and completes with `attempts: 4`. Another example: `failAttempts: 5`, killed during attempt 3's failure sleep. Attempt 4 then hits `attempt >= MAX_ATTEMPTS` and fails with `attempts: 4`. The spec says up to 3 attempts in total and requires `attempts` = 3 on failure.
   Fix: In the claim, handle running jobs whose lease expired and that already have `attempts >= 3`. Either mark them `failed` with `attempts` kept at 3, or let them finish without incrementing. Add `AND attempts < 3` to the reclaim condition and handle the capped case separately. Alternatively, on graceful shutdown, put the in-flight job back to `queued` and undo the attempt (`attempts = attempts - 1`, `progress_completed = 0`), so a SIGTERM restart doesn't use up an attempt.

2. [minor] src/worker.ts:89 — After a graceful SIGTERM, the in-flight job stays `running`, with stale progress, until its 3 s lease expires. The UI and API keep showing it as running in the meantime. After a restart, pickup is delayed by up to the full lease time.
   Evidence: `if (stopping) return;` exits without changing the row. The lease is `now + 3000`.
   Fix: On a graceful stop, set the job back to `status='queued'`, `lease_until=0`, `run_after=0` in the same conditional update (`WHERE id=? AND attempts=?`). This also fixes the SIGTERM part of finding 1.

3. [minor] src/worker.ts:115 — After a clean worker shutdown, `/health` still reports `worker: "up"` for up to 3 s, because the heartbeat row is left in place.
   Evidence: shutdown only calls `db.close()`. `workerState()` decides from heartbeat age alone.
   Fix: Before `db.close()` on shutdown, delete the heartbeat row or set it to 0 (`DELETE FROM meta WHERE key='worker_heartbeat'`).

4. [minor] src/worker.ts:76-84 — The simulated failure path doesn't check `stopping` and doesn't renew the lease or heartbeat. That's harmless now with `STEP_MS` = 100. But if `STEP_MS` or `LEASE_MS` changes, a long failure sleep could let the lease expire and a second claim double-count an attempt.
   Evidence: `await sleep(STEP_MS)` followed by an unconditional requeue or fail.
   Fix: Use the same `stopping` check and lease-renewal pattern as the step loop. Or skip the sleep and fail immediately: the spec says "fails at its first step, before any progress".

The other areas look correct from reading the code:
- **Validation:** unknown fields, types, ranges, Content-Type, the `Idempotency-Key` format, and `"body"` field errors.
- **Idempotency:** `BEGIN IMMEDIATE` plus a UNIQUE key, and payloads compared after defaults.
- **Routing:** 404/405 handling.
- **Ordering:** newest first in the list, oldest first in the worker.
- **Timing:** 200 ms poll, 500 ms retry delay, heartbeat every 1 s.
- **UI:** test IDs, `role="alert"`, numeric conversion, 1 s polling.
- **Build:** the `.ts` import rewriting works through `rewriteRelativeImportExtensions`.

I only had file-reading tools, so none of this was built or run.