# Review findings

1. [major] src/worker.ts:62 — Restart recovery can push `attempts` past the 3-attempt limit. On startup, every `running` job goes back to `queued` with its `attempts` unchanged, and `startAttempt` then adds 1. Suppose the worker is killed during attempt 3, for example a `failAttempts: 2` job that is running its successful third attempt. After restart that job runs as attempt 4, completes, and reports `attempts: 4`. The task allows "up to 3 attempts in total" and says a recovered job "completes, or fails per the retry rules".
   Evidence: The recovery query is `UPDATE jobs SET status='queued', completed=0 ... WHERE status='running'`, which does not touch `attempts` or check the limit. `processAttempt` only checks `attempt >= MAX_ATTEMPTS` on the failure branch, so the success path has no cap.
   Fix: Treat the interrupted attempt as the one being retried. In recovery, run `attempts = MAX(attempts - 1, 0)` so the re-run reuses that attempt number. Alternatively, have `startAttempt` skip the increment for recovered jobs, for example with a `recovered` flag column. Either way, `attempts` must never go above 3.

2. [minor] src/worker.ts:72-97 — On a graceful SIGTERM, the worker leaves its last heartbeat in place. `/health` keeps returning `worker: "up"` for up to 3 seconds after the worker has exited. A check that stops the worker and then expects `down` straight away would fail.
   Evidence: The shutdown path only clears the interval and closes the DB. Nothing deletes or ages the `heartbeats` row.
   Fix: Before `db.close()` on shutdown, run `DELETE FROM heartbeats WHERE name='worker'` (or set `at = 0`).

3. [minor] src/worker.ts:55 — If SIGTERM arrives mid-job, the job is left `running` until the next worker start. That is acceptable under the restart rules. The catch is that the next start relies on the recovery query, which has the attempts problem in finding 1, so a graceful stop during attempt 3 also produces `attempts: 4`.
   Evidence: `if (stopping) return; // Left as "running"`.
   Fix: On a graceful stop, requeue the job right away, set `next_run_at = 0` and roll back the attempt increment (`attempts = attempts - 1`). It then gets reprocessed cleanly without depending on crash recovery.

4. [minor] ui/index.html:87,135 — The job list is rebuilt from scratch every second with `replaceChildren`, even when nothing has changed. Any `job-item`, `job-status` or `job-result` element an automated evaluator is holding becomes detached within 1 second. That can cause intermittent "element detached" failures when the evaluator waits for status or progress to change on a specific item.
   Evidence: `renderJobs` creates new `<li>` nodes on every poll.
   Fix: Update in place. Keep a `Map` from id to element, update only the `textContent` of the status, progress and result spans, insert new jobs at the top, and remove only jobs that have disappeared.

I read all of `src/` and `ui/` but did not build, start or call the app. Nothing else was a clear defect. Validation, error shapes, 404/405 routing, idempotency (lookup and insert run synchronously in one process, and the key is enforced as UNIQUE in the DB), the retry delay of 250–2000 ms, writing progress after each step, health liveness, and the UI's `data-testid` attributes and numeric coercion all match the task as written.