The job tracker is built and both check suites pass: smoke 2/2 and contract 5/5. The build compiles, and the server and worker start with the documented commands.

I also ran these by hand, since the checks don't cover them:
- **Retries:** `failAttempts: 3` ends `failed` with `attempts: 3` and error `"transient failure"`.
- **Crash recovery:** a worker killed with `SIGKILL` mid-job is restarted, and the job completes with the correct output.
- **Validation and routing:** rejected bodies return the expected `fields`. Unknown paths return 404, and wrong methods return 405.
- **UI script:** the inline script parses. I did not check the page in a browser.

**Files changed**
- `src/db.ts`: opens the database and creates the `jobs` and `worker_heartbeat` tables.
- `src/store.ts` (new): all job and heartbeat reads and writes, shared by server and worker.
- `src/validation.ts` (new): request validation, including the `Idempotency-Key` check.
- `src/server.ts`: the HTTP API and `GET /`.
- `src/worker.ts`: the processing loop, retries, heartbeat, and recovery of interrupted jobs at startup.
- `ui/index.html`: the form, error region, and job list, polled every second.

**Choices I made**
- A job that was `running` when the worker died is requeued at the next worker start, and its interrupted attempt still counts toward `attempts`. That follows "attempts = attempts started". The cost is that a crash during attempt 3 can leave `attempts` at 4.
- Retry delay is random between 250 ms and 2 s.
- On `SIGTERM` the worker exits right away, leaving any running job for recovery on the next start.
- The UI sends `steps` and `failAttempts` as numbers when they are numeric, and as typed text otherwise so the API rejects them. Empty fields are omitted, so the defaults apply.

I did not commit anything. The untracked dotfiles and folders in the repo root were already there and I left them alone.