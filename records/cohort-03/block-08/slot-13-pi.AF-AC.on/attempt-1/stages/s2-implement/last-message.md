The job tracker is implemented in `src/` and `ui/`. `npm run build` is clean, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I also ran the server and worker by hand against a temp database and checked the behaviours in the plan, using `curl` and a script. The browser UI was not exercised in a real browser. I only confirmed its inline script parses.

**What I changed**
- `src/db.ts`: kept `openDatabase`. Added `migrate` (the schema from the plan), a `transaction` helper that rolls back on error, `toJob` for the public job shape, and the heartbeat constants.
- `src/server.ts`: rewritten. Covers routing with 404/405 and JSON errors, validation that collects every offending field, idempotency with a canonical payload, `/health` from the worker heartbeat, `GET /` serving the UI, and SIGTERM shutdown.
- `src/worker.ts`: rewritten. Writes a heartbeat every second, recovers `running` jobs at startup, claims the oldest due job in a `BEGIN IMMEDIATE` transaction, runs steps with progress updates, handles retries with a 500 ms delay, and shuts down cleanly on SIGTERM/SIGINT.
- `ui/index.html`: the form with all required `data-testid`s, `novalidate`, an error region with `role="alert"`, and a list refreshed every second using `textContent`.

**What I verified by hand**
- Create and get, newest-first listing, and progress rising during a run.
- Validation rejections (steps as a string, failAttempts out of range, unknown field, missing input, malformed JSON, `[]`, text/plain, bad key, whitespace-only input, `1.5`), with the job count unchanged afterwards.
- Idempotency: same key and payload returns 200, a changed payload returns 409, and a replay after server restart returns 200.
- Retries: `failAttempts` 1 completes on attempt 2, 2 on attempt 3, and 3 ends `failed` with attempts 3.
- Crash recovery: `kill -9` on the worker mid-run, `worker: "down"` within 3 s, then restart completes the job with output intact.
- SIGTERM: both processes exit with code 0. Unknown paths return JSON 404 and wrong methods return 405.

**Choices where I departed from the plan**
- **Crash recovery keeps `attempts` unchanged.** The plan decremented it, but the task defines `attempts` as attempts started, so a crash-interrupted attempt stays counted. A job interrupted mid-run therefore shows `attempts: 2` after recovery. Failure is still decided by attempt number, as the spec says.
- **Steps and failAttempts inputs are `type="text"` with `inputmode="numeric"`, not `type="number"`.** Text fields let any entry reach the API, so its validation always produces the message.
- **A simulated transient failure waits one step (100 ms) before failing.** This keeps the `running` state visible for a moment, and no progress is recorded.

Nothing is committed. The repo still has the untracked dotfiles that were already present; I did not touch them.