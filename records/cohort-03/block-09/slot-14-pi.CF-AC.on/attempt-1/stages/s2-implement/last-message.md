The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass.

I did not commit anything.

**Changed files**
- `src/db.ts`: schema creation, which either process can run, plus a transaction helper, prepared statements, and conversion to the public job shape.
- `src/jobs.ts` (new): shared types, the payload fingerprint, and validation that reports every offending field.
- `src/server.ts`: routing, body reading, idempotency, health, and graceful shutdown.
- `src/worker.ts`: sequential processing, progress updates, persisted retry deadlines, recovery of `running` jobs, and a heartbeat.
- `ui/index.html`: the form, the polling job list, and the required `data-testid` attributes.

**Checked by hand on temporary databases**
- Validation returns all offending fields together, and `Idempotency-Key` checks work.
- `failAttempts: 3` ends `failed` after 3 attempts with `"transient failure"`.
- Idempotency returns 201, then 200 on replay, then 409 on a different payload.
- Unknown routes return 404 and wrong methods return 405.
- Health goes to `worker: down` after the worker is killed.
- A worker killed mid-job and restarted completes the same job ID, and the output is correct.

**Not verified**
- The browser page is served but I did not load it in a browser.
- I did not test simultaneous startup with a missing parent directory.
- I did not test a kill during a retry delay or during the successful third attempt.
- I did not run the full list of behaviours in the plan.

**Choices I made**
- Retry delay is 500 ms, which is within the required 250 ms to 2 s window.
- Request bodies over 64 KiB get a `400` with field `body`.
- If the worker is stopped mid-attempt, the job stays `running` and recovery picks it up on restart. Recovery keeps the attempt number and restarts progress from zero.

The untracked dotfiles in the repository were already there and I left them alone.