The job tracker is implemented and runs. `npm run build` succeeds, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit anything.

**What changed**
- `src/db.ts`: opens the database, creates the directory, sets `busy_timeout` before WAL, and creates the schema in one immediate transaction. It also provides a `transaction` helper.
- `src/jobs.ts` (new): validation that collects every field error, job serialization, idempotent creation in one transaction, the heartbeat, and the worker's claim/progress/complete/retry/fail operations.
- `src/server.ts`: routing with 404/405 JSON errors, the API, `/health`, a 500 fallback, and a bounded drain on SIGINT/SIGTERM.
- `src/worker.ts`: heartbeat every 500 ms, polling every 100 ms, one job at a time, a 100 ms step, retries with a 500 ms delay, and a stop at a step boundary on signal.
- `ui/index.html`: the form and list with every required `data-testid`, `novalidate` form, DOM-built text, and serialized polling every 500 ms.

**Verification**
- A scratch end-to-end script in `$TMPDIR` covered validation (malformed JSON, wrong content type, arrays, unknown fields, whitespace, null, bad keys), idempotency (replay, conflict, and a 4-way concurrent race giving one ID), routing, Unicode uppercasing, and retries for `failAttempts` 0, 1, 2, 3, and 5 (attempt totals 1, 2, 3, 3, 3).
- SIGKILL during attempt 3 of a 20-step job: the job showed `running`, `attempts: 3`, and progress reset to 0 after restart. It then completed with `attempts: 3`. Health went to `down` after the kill and back to `up` after restart.
- SIGTERM stopped both processes cleanly.

**Choices I made**
- A job left `running` after a crash resumes without incrementing `attempts`, so a crash during attempt 3 cannot create a fourth attempt.
- A retry is delayed by 500 ms, and `HEAD` is treated as `GET` on GET routes.
- Request bodies over 64 KB are rejected as an invalid body.
- An empty numeric field in the UI is sent as `""` so the API rejects it, rather than becoming `0`.

**Not verified**
- I did not open the page in a real browser. I checked the required `data-testid` attributes in the HTML and the rendering logic by reading the code.
- I did not test the worker-first and simultaneous-start orders, or SIGKILL during an ordinary step or a retry delay, with separate runs.