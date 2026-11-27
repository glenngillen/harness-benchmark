A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:29-34, 69-71 (and claimNext at :41) — A job can run more than 3 attempts, and a job that ends `failed` can show `attempts > 3`. Both crash recovery (`recoverInterruptedJobs`) and graceful shutdown (`requeue`) put a `running` job back to `queued` but leave `attempts` as it was. `claimNext` then adds 1 again.
   Evidence: Reasoning through the code: take a job with `failAttempts: 0` that is killed with SIGKILL, or stopped with SIGTERM, during attempt 3. On restart it is claimed as attempt 4 and completes with `attempts: 4`. That breaks "up to 3 attempts in total". With `failAttempts: 5`, a job interrupted while `attempts=3` is claimed as attempt 4. It fails because 4 ≤ 5, and `failAttempt` marks it `failed` with `attempts: 4`. The spec says a failed job must have `attempts` set to 3. The same off-by-one also shifts which attempt number gets the simulated failure: a `failAttempts: 2` job interrupted during attempt 2 restarts as attempt 3 and succeeds, where it should fail once more.
   Fix: Treat an interrupted attempt as not finished, so the next run reuses its attempt number. In `recoverInterruptedJobs` and `requeue`, set `attempts = MAX(attempts - 1, 0)` along with `status='queued'` and `progress_completed=0`. Alternatively, in `claimNext`, don't increment past `MAX_ATTEMPTS` when the row came from an interrupted run. Either way, `attempts` must never go above 3, and a job must end `failed` with exactly 3.

2. [minor] ui/index.html:50-54 — `fieldValue` uses `Number(text)`, which also accepts hex (`"0x10"` → 16), exponents (`"1e1"` → 10), and `"Infinity"`-style edge cases. So the form can send a different number from what the user typed, and the API's validation is applied to the converted value, not the input.
   Evidence: `Number("0x3")` is `3`, so typing `0x3` in Steps submits `steps: 3` and is accepted.
   Fix: Convert only plain decimal text, e.g. `/^-?\d+(\.\d+)?$/.test(text) ? Number(text) : raw`. Send anything else as the raw string so the API rejects it and names the field.

3. [minor] src/worker.ts:14-18, 108-125 — When SIGTERM arrives during a job, the worker requeues the job at the next step boundary. That costs an attempt (see finding 1), and the heartbeat row stays fresh for up to 3 s after the worker exits, so `/health` keeps reporting `worker: "up"` briefly.
   Evidence: `requeue` doesn't touch `attempts`, and nothing clears or ages the heartbeat on shutdown.
   Fix: Apply the attempt fix from finding 1 in `requeue`. On clean shutdown, before `db.close()`, delete the heartbeat row or set `beat_at` to 0 so health reports `down` straight away.

I only read the code; I didn't build or run anything. Everything else I checked matches the task: validation, idempotency (key check and insert in one transaction), routing, 404/405 handling, health heartbeat timing, step timing (100 ms), retry delay (500 ms), and the UI test IDs and polling.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
