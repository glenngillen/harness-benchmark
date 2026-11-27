The job tracker is implemented. `npm run build` is clean, and both fixed suites pass (smoke 2/2, contract 5/5). I also ran extra checks by hand against a live server and worker. Nothing is committed.

**Files**
- `src/db.ts`: connection setup, plus `migrate()` creating the `jobs` and `heartbeats` tables.
- `src/jobs.ts` (new): constants, the row type, and the JSON mapping for jobs.
- `src/server.ts`: routing, validation, idempotency, and `/health`. Idempotency lookup and insert run inside `BEGIN IMMEDIATE`.
- `src/worker.ts`: claims the oldest due job, runs steps with progress updates, handles retries, writes a heartbeat every second, and shuts down on SIGTERM/SIGINT.
- `ui/index.html`: the form and job list with the required `data-testid`s. It polls `/api/jobs` every second and renders all text with `textContent`.

**Checks I ran beyond the fixed suites**
- Validation: whitespace-only input, unknown fields, numeric strings, non-integers, malformed JSON, non-object bodies, missing Content-Type, and a bad Idempotency-Key. Each returned 400 and named the field.
- Idempotency: same key and payload returned 200 with the original job. A different payload returned 409. The key created exactly one job.
- Routing: unknown path returned 404 and wrong method returned 405.
- Retries: `failAttempts: 3` ended `failed` with `"transient failure"` and `attempts: 3`.
- Health: `worker: "down"` with no worker, `"up"` while it runs.
- Restart: SIGKILL of the worker mid-job. On restart the job was requeued and completed on attempt 2.
- Page script: passes `node --check`. I did not test it in a browser.

**Choices you may want to review**
- **Crash recovery:** on worker startup, any job left `running` is requeued. The interrupted attempt stays counted in `attempts`. If that attempt was the third, the recovered run still goes ahead rather than failing, because the 3-attempt cap covers simulated failures only.
- **Retry delay:** fixed at 1 s. Each step is 100 ms. The worker polls for work every 200 ms.
- **Form input:** the step and failure fields are plain text rather than number inputs, so the API does the validation and its errors show in `form-error`. Numeric text is sent as a number. Other text is sent as typed.
- **Body size:** requests over 64 KB are rejected with `400` on field `body`. The spec does not set a limit.