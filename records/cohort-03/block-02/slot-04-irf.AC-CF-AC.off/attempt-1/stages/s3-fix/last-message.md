I fixed the finding. Restart recovery and graceful shutdown no longer erase started attempts.

**Changes**
- `src/db.ts`: `requeueJob` no longer takes a `countAttempt` flag and never touches `attempts`. `recoverInterruptedJobs` only moves `running` jobs back to `queued`, keeping their `attempts`.
- `src/worker.ts`: updated the two `requeueJob` calls to match. The retry logic still reads `job.attempts`, which is now the true count.

**Verification**
- `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass.
- I ran a SIGKILL restart test. The job showed `attempts: 1` while running. After the kill and restart it completed with `attempts: 2`, so the interrupted attempt stayed in the history. The worker also shut down cleanly on SIGTERM, and no processes were left running.

**Trade-off**
A job interrupted during a failing attempt can now consume one of its three attempts. The spec doesn't address this case, so I followed the reviewer's reading of `attempts`. A job that crashes repeatedly can also exceed three attempts. Its status still follows the retry rules, because the cap applies only to simulated failures.

Nothing was declined. I also didn't touch the process on port 3917 from earlier, which is not part of this workspace.