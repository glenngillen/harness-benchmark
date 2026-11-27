The job tracker is implemented. `npm run build` succeeds, and both fixed suites pass (smoke 2/2, contract 5/5).

**What I changed**
- `src/db.ts`: `openDatabase()` keeps the busy_timeout and WAL pragmas and now runs an idempotent schema migration. It also holds the shared helpers: the job JSON mapping, a `BEGIN IMMEDIATE` transaction wrapper, and the heartbeat read and write.
- `src/validate.ts` (new): a pure submission validator that collects every offending field, including unknown fields, the `Idempotency-Key` header and whole-body problems.
- `src/server.ts`: `node:http` routing for `/health`, `/`, `/api/jobs` and `/api/jobs/:id`, with 404/405 handling. It also has body reading, idempotent create with a 409 on a payload mismatch, list and get, a 500 fallback, and SIGTERM/SIGINT shutdown with a 2 s force-exit.
- `src/worker.ts`: startup recovery of `running` jobs, a 500 ms heartbeat, the claim/step/retry loop, and a SIGTERM path that requeues an in-flight job before closing the database.
- `ui/index.html`: the form and error region with the required `data-testid`s, and a 1 s polling list built with `textContent` only. The form uses `novalidate`, so out-of-range values reach the API and its error is shown.

**What I verified by running it**
- Each listed validation case returned 400 with the right field. Content-Type with a charset is accepted, and an invalid `Idempotency-Key` is rejected.
- Routing: unknown path 404, `DELETE /api/jobs` 405, unknown job id 404.
- Idempotency: same key and payload gives 200 with the same job, a different payload gives 409, and the replay still gives 200 after a SIGKILL restart of both processes.
- Retries: `failAttempts: 2` completes with 3 attempts; `failAttempts: 3` ends `failed` with "transient failure", a null result and 3 attempts.
- Crash recovery: a worker killed mid-run finishes the job after restart. Completed jobs are not reprocessed.
- Health: `worker` shows `down` within about 3 s of a SIGKILL, and immediately after SIGTERM.
- Shutdown: both processes exit promptly on SIGTERM.
- The inline UI script parses and `/` serves the page. I did not exercise the page in a real browser.

**Choices you may want to review**
- A job interrupted by a worker crash or SIGTERM keeps the attempt it had started in `attempts`, so the next run shows one extra attempt.
- The retry delay is a fixed 500 ms, which is within the 250 ms–2 s window.
- Request bodies over 1 MB are reported as a `body` error rather than a 413.

I did not commit anything, since you did not ask for a commit. The untracked dotfiles and `.idea`/`.vscode` directories were already present before I started.