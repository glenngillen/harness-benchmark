The job tracker is built and both fixed check suites pass: smoke 2/2 and contract 5/5. Everything is uncommitted in the working tree.

**What changed**
- `src/db.ts`: opens SQLite in WAL mode and creates the `jobs` and `meta` tables. Both processes run this, and it is idempotent.
- `src/store.ts` (new): all SQL. Idempotency is a `UNIQUE` column, so a key can't create two jobs, even across restarts.
- `src/jobs.ts` (new): job shape, payload validation with per-field errors, and the retry constants.
- `src/server.ts`: all routes, the 400/404/405/409 error shapes, and `/health`. Worker is `up` only if the heartbeat is under 3 s old.
- `src/worker.ts`: on startup it requeues jobs left `running`, writes a heartbeat every second, and claims the oldest eligible queued job. Each attempt sleeps 100 ms per step and updates progress. Retries are delayed 250–2000 ms, and the third failure marks the job `failed`.
- `ui/index.html`: the form and job list with every required `data-testid`. It polls every second and sends empty numeric fields as omitted, so the API defaults apply.

**Verification**
- `npm run build` is clean, and both check suites pass.
- A scratch end-to-end script (outside the repo) passed 40 of 40 checks. It covered validation edge cases, 404/405 routing, retry-to-failure, retry-then-complete, idempotency, a `SIGKILL` restart with a running job that was then reprocessed, and clean `SIGTERM` exits.

**Choices I made**
- A `SIGKILL`ed attempt still counts toward `attempts`, since it was started.
- On graceful `SIGTERM` the worker stops after the current step and leaves the job `running`. The next start requeues it.
- The idempotency key is global, not per payload or per route.
- `GET /api/jobs` returns every job, with no pagination.

**Not verified**
- I did not load the page in a real browser. I only confirmed its inline script parses.

**Things you should know**
- Port 3917 is held by a process I can't see in `ps`. My first scratch run hit it and got misleading results, so I reran on port 4817. I left the other process alone.
- One Bash call was denied for approval because it combined a scratch-directory `rm` with the test run. I did not retry it, and nothing was deleted from the repo.