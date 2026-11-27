I accepted the finding and made the fix. `attempts` now counts every attempt that was started, including one cut short by a crash, and it is capped at 3.

**Changes**
- **`src/jobs.ts`**: recovery no longer decrements `attempts`. A job left `running` is requeued with `completed = 0`. If its interrupted attempt was the third one and that attempt would have failed (`attempts >= 3` and `attempts <= fail_attempts`), it is marked `failed` with `error = "transient failure"` right away. `claimNextJob` now uses `min(attempts + 1, 3)`, so a requeued third attempt runs again without pushing the count past 3.
- **`src/worker.ts`**: updated the shutdown comment to match.

**Verification**
- `npm run build` succeeds, and both fixed suites pass (`check:smoke` 2/2, `check:contract` 5/5).
- A `failAttempts: 0` job killed with SIGKILL mid-run and then finished after restart reports `attempts: 2`.
- Calling the recovery and claim functions directly on a DB row with `attempts = 3` gives the expected results. `failAttempts: 3` is marked `failed`. `failAttempts: 2` is requeued, claimed as attempt 3, and `attempts` stays at 3.

**Not covered:** the attempt-3 branches were tested by writing the DB state directly, not by killing a real process at that moment. The crash-loop case is bounded only in that a job stuck on attempt 3 with `failAttempts ≤ 2` keeps re-running at `attempts = 3`. That is the correct cap under the spec, but it does not stop a worker that crashes repeatedly on the same job.