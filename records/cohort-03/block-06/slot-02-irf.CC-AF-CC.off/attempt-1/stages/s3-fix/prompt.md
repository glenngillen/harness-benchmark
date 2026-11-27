A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:9, src/worker.ts:17-24 — Crash recovery can push a job past the 3-attempt limit. On startup, `running` jobs go back to `queued` without checking `attempts`, and `processJob` always increments. So a job that was on attempt 3 when the worker died starts attempt 4. With `failAttempts ≥ 3` it then ends `failed` with `attempts: 4`, but the spec requires 3. With a lower `failAttempts` it completes on a 4th attempt, which breaks "up to 3 attempts in total".
   Evidence: the requeue at line 9 has no `attempts` guard. The claim at line 17 runs `attempts=attempts+1` with no upper bound. The terminal check is `attempt >= 3`, so it fires on 4 as well.
   Fix: claim jobs only when `attempts < 3`. In the startup recovery, either mark jobs with `attempts >= 3` as `failed` (`error='transient failure'`, `result_output=NULL`) or treat the interrupted attempt as a failed attempt under the retry rules. Clamp `attempts` to 3 in the terminal update.

2. [major] src/worker.ts:21 — A graceful `SIGTERM` during a job returns early and leaves the row `running` with partial progress. The job only recovers on the next worker start, which uses up an extra attempt (and with finding 1 can exceed the limit). Until then, the API and UI show a stale `running` job with no worker processing it.
   Evidence: `if (stopping) return;` runs before any status reset. The only reset is the startup `UPDATE ... WHERE status='running'`.
   Fix: on a graceful stop, finish the current step and set the job back to `queued` with `progress_completed=0` and `attempts=attempts-1`, since the attempt was not a real failure. Or finish the job before exiting; jobs take at most about 2 s.

3. [major] src/worker.ts:17-18 — The claim does not check that it actually took the row. `attempt` is computed from the stale `row.attempts`, and processing continues even if the guarded UPDATE changed nothing. That happens if a second worker instance runs, or if a restart overlaps with an old process still shutting down. Two processes could then run the same job, and later updates would overwrite each other.
   Evidence: the `.run(...)` result is ignored, and lines 31 and 33 depend on `status='running'`, which is true for both processes.
   Fix: claim atomically with `UPDATE ... WHERE id=? AND status='queued' RETURNING attempts`, or check `changes === 1`. Skip the job if the claim failed, and take `attempt` from the returned value.

4. [minor] src/server.ts:27 — The request handler is an `async` function with no catch-all. Any exception thrown outside the local try blocks becomes an unhandled rejection, which kills the server process in Node 22. Examples: `SQLITE_BUSY` after the 5 s busy timeout, an error from `getJob`, or the `throw error` after `ROLLBACK` at line 93.
   Evidence: the `createServer(async (req, res) => {...})` body has no outer try/catch, and there is no `process.on('unhandledRejection')` handler.
   Fix: wrap the handler body in try/catch and respond `500 {"error":{"code":"internal_error",...}}` if headers haven't been sent yet.

5. [minor] src/worker.ts:38-42 — An exception in `heartbeat()` or the SELECT (for example `SQLITE_BUSY` under contention with the server) escapes the loop. The worker closes the database and exits, so `/health` reports `down` and jobs stall.
   Evidence: there is a `try/finally` with no catch. Only the interval heartbeat (line 12) swallows errors.
   Fix: catch errors per loop iteration, log them, sleep briefly, and continue. Exit only when `stopping` is set.

6. [minor] ui/index.html:46 — If the steps or fail-attempts field is cleared, `Number('')` sends `0` instead of leaving the field out. An empty steps field is then rejected (`steps: 0`) instead of using the default of 5, and an empty fail-attempts field silently becomes 0.
   Evidence: `steps: Number(data.get('steps'))` always sends a number.
   Fix: when a numeric field's value is the empty string, leave that key out of the payload so the API defaults apply. Otherwise send `Number(value)`.

7. [minor] ui/index.html:33-39, 56 — `render` rebuilds `job-list` with `innerHTML` every 500 ms even when nothing changed. Every `job-item`, `job-status` and other element is replaced on each poll. A browser-driven evaluator holding element handles will get stale-element errors, or read nodes that are being swapped out.
   Evidence: `list.innerHTML = jobs.map(...)` runs on every refresh.
   Fix: keep each `<li>` keyed by `data-job-id` and only update the text of `job-status`, `job-progress` and `job-result`. Insert new items at the top. At minimum, skip the re-render when the JSON is unchanged.

I didn't run the build or the app; all of these come from reading the code. The parts I checked that look correct: validation, the idempotency transaction (`BEGIN IMMEDIATE` plus a re-check), 404/405 routing, the heartbeat window, the retry delay (fixed 500 ms, which is within the allowed range), and the job JSON shape.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
