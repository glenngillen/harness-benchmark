All four findings were correct, and I fixed each one. The build and both check suites pass after the final edit, and the scenario from finding 1 now behaves as the spec requires.

**What changed**
- **Finding 1 (attempts counting):** I chose option A. An interrupted attempt no longer counts.
  - New `requeueInterrupted` in `src/jobs.ts` undoes the attempt's increment, and the graceful-shutdown paths in `src/worker.ts` use it.
  - `recoverInterruptedJobs` also undoes the increment for jobs left `running` after a crash.
  - So `attempts` only counts attempts that ran to a result, and the existing 3-attempt rule applies everywhere.
- **Finding 3 (shutdown during attempt 3):** Fixed by the same change. The interrupted attempt is undone, so the job is retried as attempt 3 and fails correctly.
- **Finding 2 (malformed percent-escape):** `src/server.ts` catches the `decodeURIComponent` error and returns `404 not_found`. `GET /api/jobs/%E0` now returns 404.
- **Finding 4 (stray file):** Deleted `wpid`, which was my leftover from testing. The other untracked dotfiles and `scripts/` were already present before I started, so I left them alone.

**Verified**
- `failAttempts: 3`, SIGKILL while running at attempt 3, then restart: the job ends `failed` with `attempts: 3` and `"transient failure"`.
- `npm run build`, `check:smoke` (2/2), and `check:contract` (5/5) pass.

**Not added:** I did not add a permanent automated test for the SIGKILL case. I ran it as a manual script, so there is no regression test in the repo. The repo has no test runner, and I did not add dependencies.