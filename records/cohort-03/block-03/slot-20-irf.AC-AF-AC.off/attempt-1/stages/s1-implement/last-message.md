The job tracker is built, and both provided suites pass: smoke 2/2 and contract 5/5. I also ran the server and worker by hand against a fresh database and checked the behaviour the suites don't cover. Nothing is committed; the changes are in the working tree.

**What I changed**
- `src/db.ts`: opens SQLite as before and creates the `jobs` and `worker_heartbeat` tables.
- `src/jobs.ts` (new): job storage, the job JSON shape, and the atomic claim of the oldest runnable job.
- `src/validation.ts` (new): request validation with defaults, collecting every offending field.
- `src/server.ts`: all routes, the 400/404/405/409 errors, idempotency keys, and the health check, which reports the worker up if its heartbeat is under 3 s old.
- `src/worker.ts`: claims queued jobs one at a time, runs 100 ms steps with progress written after each, retries failed attempts after 500 ms, requeues jobs left `running` after a crash, and writes a heartbeat about once a second.
- `ui/index.html`: the form and job list with the required `data-testid` attributes. It polls `/api/jobs` every second and shows API rejections, including field names, in `form-error`.

**Choices I made where the spec was open**
- A worker that stops mid-job reverts that attempt rather than counting it, so only a crash counts against `attempts`.
- The worker writes a zero heartbeat on clean shutdown, so health reports `down` right away.
- The UI sends the step and fail-attempt fields as text, converted to numbers only when numeric, so the API rejects bad values with field names. It omits empty fields so defaults apply.
- Idempotency keys are a unique column on the job row, so a key cannot create two jobs even across restarts.

**Checked by hand:** validation and routing errors, `failAttempts: 3` ending `failed` with `attempts: 3`, `failAttempts: 2` completing on attempt 3, a worker killed with SIGKILL (health goes `down` after about 3 s, then back `up` after restart, and work queued while it was down gets processed), clean SIGTERM exit for both processes, and data surviving a server restart.

**Not verified:** I did not test a worker killed mid-job and then restarted, and I did not open the page in a browser. The page script parses, and the DOM it builds follows the `data-testid` table.

**Stray process:** something unrelated is listening on port 3917. I could not see it in `ps`, so I left it alone.