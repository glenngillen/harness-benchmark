The job tracker is implemented. `npm run build`, `check:smoke`, and `check:contract` all pass (2/2 and 5/5). I did not commit anything.

**What changed**
- `src/db.ts`: kept `openDatabase`, added the schema (`jobs`, `worker_heartbeat`), the `Job` type, `rowToJob`, and `nowIso`.
- `src/server.ts`: rewritten on `node:http`. It has the router, strict validation with every offending field collected, idempotency inside `BEGIN IMMEDIATE`, `/health`, the UI route, and SIGTERM/SIGINT shutdown.
- `src/worker.ts`: rewritten. It writes a heartbeat every second, requeues leftover `running` jobs on startup, polls every 200 ms, and runs 100 ms steps with progress written after each one. Retries go back to `queued` with a 500 ms delay, capped at 3 attempts. SIGTERM requeues any in-flight attempt and exits 0.
- `ui/index.html`: the form, job list, 1 s polling, and every required `data-testid`. It uses `textContent` only and sends `novalidate`.

**Verified by hand against live processes** (temp DB):
- Validation cases from the plan each return 400 with the right field, and the job count stays unchanged.
- Defaults, idempotency (200 replay, 409 conflict), and the replay after a server `kill -9` restart all return 200 with the same id.
- Progress rises 0→10 and completes with `PROGRESS ME`.
- `failAttempts: 2` completes with attempts 3. `failAttempts: 3` fails with attempts 3, error `transient failure`, and null result.
- Worker `kill -9` mid-run: health goes `down` within 3 s, and after restart the job completes at 20/20 within about 3.5 s.
- Route checks: 405, 404, and 405 as expected.
- Both processes exit 0 on SIGTERM. Starting with `DATABASE_PATH` in a nested fresh directory creates the directories.

**Choices and deviations**
- I did not add the `catch UNIQUE and re-lookup` fallback from the plan. The insert runs inside a synchronous `BEGIN IMMEDIATE` transaction, so there is no race for it to handle.
- The UI was checked by reading it and by a syntax check of its script. I had no headless browser, so the form-error and live-update behaviour is untested in a real browser.
- I did not separately test SIGTERM during a step. It uses the same requeue SQL that the `kill -9` recovery test exercised.
- Running the checks and my manual tests created a gitignored `data/` directory in the workspace. I removed it.