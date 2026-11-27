The job tracker is implemented. `npm run build` succeeds, both fixed check suites pass (smoke 2/2, contract 5/5), and I verified the rest of the spec by hand against running processes.

**What I changed** (only under `src/` and `ui/`; nothing fixed was touched, and I haven't committed):
- `src/db.ts`: opens the database and creates the schema (`jobs`, `idempotency_keys`, `heartbeat`), and maps rows to the API job shape.
- `src/validate.ts` (new): validates submissions and reports every offending field.
- `src/server.ts`: routing, JSON errors, create/list/get, idempotency in one `BEGIN IMMEDIATE` transaction, health, and SIGTERM handling.
- `src/worker.ts`: heartbeat every 500 ms, claim loop, per-step progress writes, retries, crash recovery, and SIGTERM handling.
- `ui/index.html`: form, `form-error` region, polled job list, every required `data-testid`. All text is set with `textContent`.

**Verified by hand:**
- Validation: every case in the spec returns 400 `invalid_request` with the right field, and creates no job.
- Routing: `DELETE /api/jobs` gives 405; unknown paths give 404, all as JSON.
- Retries: `failAttempts: 2` completes on attempt 3; `failAttempts: 3` ends `failed` with `"transient failure"` after 3 attempts.
- Idempotency: same key and payload gives 201 then 200; a different payload gives 409; the replay still returns the same job after a restart.
- Crash recovery: SIGKILL on the worker mid-job, then restart, reruns the job (attempts 1→2) and it completes. After SIGKILL of both processes and restart, all jobs are listed and the completed job's `updatedAt` is unchanged.
- Health reports `worker: "down"` about 3 s after the worker is killed.
- SIGTERM: both processes exit with code 0.

**Not verified:** I did not run the UI in a browser. I checked the inline script's syntax and the test IDs, but not live polling or the form's error display.

**Judgment calls:**
- A failing attempt sleeps one step before failing, so it appears briefly as `running`.
- On SIGTERM mid-job, the worker puts the job back to `queued` with progress reset. The attempt still counts.
- Crash recovery counts the interrupted attempt, so `attempts` goes up by one. The 3-attempt cap applies to simulated failures only; a crash during attempt 3 of a job that would succeed reruns as attempt 4 and can complete.
- Lone UTF-16 surrogates in `input` are stored as SQLite's replacement characters, not rejected.