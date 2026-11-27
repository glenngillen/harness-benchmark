The finding is fixed, and both checks pass after the change.

- **Fix:** in `src/worker.ts`, the claim UPDATE now sets `attempts = MIN(attempts + 1, 3)`. A job reclaimed from a crashed attempt 3 reruns as attempt 3, so `attempts` never exceeds 3.
- **Build and checks:** `npm run build` succeeds, `check:smoke` passes 2/2, and `check:contract` passes 5/5.
- **Reclaim test:** I wrote two jobs, then set them in the database to `running` with `attempts: 3` and an expired lease, as a crash during attempt 3 would leave them. After the worker started:
  - `failAttempts: 0` completed with `attempts: 3` and output `CRASH OK`.
  - `failAttempts: 5` ended `failed` with `attempts: 3` and `error: "transient failure"`.

I took the reviewer's suggested behaviour: a reclaimed attempt 3 is re-evaluated as attempt 3 under the normal rules. I didn't add a separate branch in `claim()`, because the clamp alone gives that behaviour. The worker's `attempts` therefore counts attempts with a cap, so a crash during attempt 3 doesn't add an extra attempt.