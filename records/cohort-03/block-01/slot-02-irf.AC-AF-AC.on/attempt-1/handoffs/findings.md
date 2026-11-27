# Review findings

1. [major] src/worker.ts:38-48 and src/jobs.ts:146-166 — An interrupted attempt still counts toward `attempts`, and nothing caps attempts at 3. So after a restart, a job can run a 4th attempt and get the wrong final outcome.
   Evidence: On SIGTERM, `runAttempt` calls `requeueJob` and leaves `attempts` unchanged. After SIGKILL, `recoverInterruptedJobs` requeues the job, also leaving `attempts` unchanged. `claimNextJob` then runs `attempts = attempts + 1` without checking any limit. Example: a job with `failAttempts: 3` is killed during its 3rd attempt. It is reclaimed with `attempts=4`. The check `4 <= 3` is false, so it runs every step and ends `completed`. The spec says `failAttempts ≥ 3` must end `failed` with `attempts` = 3. With `failAttempts: 5`, the same path ends `failed` with `attempts: 4`. With `failAttempts: 0`, a completed job can report `attempts: 4`.
   Fix: Pick one rule and apply it everywhere. Option A: when an attempt is interrupted (graceful requeue or crash recovery), decrement `attempts` so it does not count. Option B: count it, but have `claimNextJob` and recovery mark a job `failed` / `"transient failure"` once `attempts >= MAX_ATTEMPTS`, and decide fail-or-succeed by the attempt number capped at 3. Either way, add a test for "SIGKILL during attempt 3 with failAttempts 3 → failed, attempts 3".

2. [minor] src/server.ts:142 — `decodeURIComponent` throws on a malformed percent-escape. The server then answers `500 internal_error` where it should answer `404 not_found`.
   Evidence: `GET /api/jobs/%E0` throws a `URIError`, which reaches the catch in `createServer` and becomes a 500.
   Fix: Wrap the decode in try/catch and return `404 not_found` (or match the raw segment against the id) when decoding fails.

3. [minor] src/worker.ts:40-42 — A graceful shutdown during the failing first step of attempt 3 requeues the job, so it is not marked `failed`. On restart it gets a 4th attempt (the root cause is in finding 1). Even once finding 1 is fixed, the interrupt path needs to agree with whatever rule you choose for counting interrupted attempts.
   Evidence: `if (interrupted()) return requeueJob(db, job.id, 0);` runs before the `job.attempts >= MAX_ATTEMPTS` check.
   Fix: Handle this case with the same rule you apply in finding 1. For example, undo the attempt increment when requeueing on shutdown.

4. [minor] wpid — There is a stray untracked file in the repo root containing a PID (`16`). It looks like a leftover from running the worker manually.
   Evidence: `git status` shows `?? wpid`, and the file contains just `16`.
   Fix: Delete the file, and don't write PID files into the repo.