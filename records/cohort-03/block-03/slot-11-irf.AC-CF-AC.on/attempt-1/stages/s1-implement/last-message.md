The job tracker is implemented. `npm run build` exits 0, and both fixed check suites pass (smoke 2/2, contract 5/5).

**What changed**
- `src/db.ts`: opens the database in WAL mode and creates the `jobs` and `heartbeat` tables. Adds a `BEGIN IMMEDIATE` transaction helper and the row-to-JSON mapping.
- `src/validate.ts` (new): request validation. It collects every offending field, including unknown fields, wrong types, and out-of-range values.
- `src/server.ts`: all routes, the 400/404/405/409 error shapes, idempotency keyed in the database, and `/health` reporting `worker: up` when the heartbeat is under 3 s old.
- `src/worker.ts`: polls for due jobs, runs steps with progress written after each one, retries with a 500 ms delay, and writes a heartbeat every second. On startup it requeues anything left `running`.
- `ui/index.html`: the form and job list with the required `data-testid` attributes. It polls `/api/jobs` every second.

**Manual checks beyond the fixed suites**
I ran the server and worker by hand on a fresh database and confirmed:
- Idempotency: same key and payload returns 200 with the same job, and a different payload returns 409.
- Retries: `failAttempts: 2` completes on attempt 3, and `failAttempts: 3` ends `failed` with `"transient failure"`.
- Validation: rejects unknown fields, string numbers, a wrong Content-Type, malformed JSON, and a bad `Idempotency-Key`. It returns 404 for unknown paths and 405 for wrong methods.
- Restarts: a job killed mid-run with `kill -9` completes after the worker restarts. Jobs and idempotency keys survive a server restart.
- Shutdown: both processes exit cleanly on SIGTERM.

I did not test the browser page in a real browser, so the UI is unverified beyond the code and the served HTML.

**Choices you may want to review**
- A job interrupted by a crash is requeued without counting that attempt, so the retry budget and the final `attempts` match an uninterrupted run.
- The retry delay is a fixed 500 ms, which is inside the 250 ms–2 s range.
- A bad or missing Content-Type is reported under field `"body"`. The spec doesn't name a field for it.

**Environment note**
During my first manual run, port 3917 was already held by a process I can't see from this sandbox. That run's API responses came from that process, not from my code, so I discarded them and reran on a free port. I did not kill anything.

The working tree also has untracked dotfiles and directories (`.bashrc`, `.github`, `scripts`, and others). They were already there, and I left them alone.