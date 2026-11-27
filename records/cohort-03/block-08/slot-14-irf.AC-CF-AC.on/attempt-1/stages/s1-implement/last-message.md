The job tracker is implemented. `npm run build` passes, and both check suites pass: smoke 2/2 and contract 5/5. The checks only cover the disclosed examples, so I also tested the rest by hand on a free port with a fresh database. I did not open the page in a browser; I only syntax-checked its script.

**What changed**
- `src/db.ts`: opens the SQLite database (WAL, busy timeout), creates the `jobs` and `worker_heartbeat` tables, and provides a write-transaction helper.
- `src/jobs.ts` (new): job queries, the public job shape, and the worker's claim, progress, retry, completion, and crash-recovery operations.
- `src/validate.ts` (new): submission validation. It reports every offending field, including unknown fields, wrong types, bad Content-Type, malformed JSON, and a bad `Idempotency-Key`.
- `src/server.ts`: routing, the `/health` worker status, the job endpoints, idempotency, and the error shape. It returns 405 with an `Allow` header and 404 for unknown paths.
- `src/worker.ts`: claims the oldest due job, runs the steps with progress writes, simulates transient failures, retries up to 3 attempts, writes a heartbeat every second, and shuts down cleanly on SIGTERM.
- `ui/index.html`: the form and job list with the required `data-testid` hooks. It polls every second and updates rows in place.

**Choices I made**
- Retry delay is a fixed 500 ms.
- A job interrupted by a crash keeps its attempt count, so it reads `attempts: 2` after one restart. If the interrupted attempt was the last one and was set to fail, the job fails on restart instead of running again.
- A blank `steps` or `failAttempts` in the form is sent as an empty string, so the API rejects it with a field error. Numeric-looking text is sent as a number.
- Request bodies over 64 KB are rejected with a 400 on the `body` field.

**Manual checks that passed**
- Validation cases: unknown field, string `"3"`, `2.5`, `null`, malformed JSON, array body, wrong Content-Type, bad key, whitespace-only input.
- Routing: 405 with `Allow`, and 404 for unknown paths.
- `failAttempts: 3` ends `failed` with `attempts: 3`. `failAttempts: 2` completes with `attempts: 3`.
- Idempotency replay returns 200, and a changed payload returns 409.
- `kill -9` of both processes mid-job, then restart: the job resumes and completes, and `/health` shows `worker: up` again.
- SIGTERM stops both processes cleanly.

**Things you should know**
- My first manual test run hit a different server already listening on port 3917. My server failed to bind, so the requests went to that other process. I left it alone. A few of my test POSTs were sent to it and created jobs in its database. I can't undo that.
- Nothing is committed. The changes are in the working tree.