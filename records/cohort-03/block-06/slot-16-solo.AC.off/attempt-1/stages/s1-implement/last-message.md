The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I also ran manual tests beyond those checks, and the behaviour matches the spec.

**What changed** (fixed files and `checks/` untouched; no dependencies added; nothing committed)
- `src/db.ts`: opens SQLite in WAL mode with a busy timeout, creates the `jobs` and `worker_heartbeat` tables if missing.
- `src/jobs.ts` (new): job shape, idempotent insert in one `BEGIN IMMEDIATE` transaction, claim/progress/complete/fail/requeue queries, heartbeat.
- `src/validation.ts` (new): body and `Idempotency-Key` validation, returning the `fields` list.
- `src/server.ts`: all routes, status codes and error shapes, plus `GET /`, with SIGTERM shutdown.
- `src/worker.ts`: polls for due jobs, runs 100 ms steps, writes progress each step, retries transient failures, heartbeats once per second on its own timer, shuts down on SIGTERM.
- `ui/index.html`: form, status list, and the required `data-testid` hooks. It polls every second and updates items in place.

**Choices I made**
- Crash recovery uses a 5 s lease on running attempts, renewed each step. Any worker can reclaim an expired lease, so no restart-time sweep is needed.
- Retry delay is a fixed 1 s.
- A job killed mid-attempt counts that attempt in `attempts`, so the re-run is attempt 3, not 2.
- The UI sends numeric-looking fields as numbers and omits empty fields so defaults apply. Anything else is sent as text so the API rejects it.

**Verified manually**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- Progress is visible mid-run (5/10 seen before completion).
- A job running when both processes were SIGKILLed was re-run after restart and completed. Health read `worker: down` until the worker came back.
- Idempotency: replays return 200, changed payloads return 409.
- Several validation cases return 400 with the right field names; wrong method returns 405, unknown route 404.
- Both processes exit on SIGTERM.

**Not verified**
- I did not open the page in a real browser. I only syntax-checked its script and confirmed the test-id attributes are in the markup.

**Blocked or left behind**
- A `rm -rf` cleanup was denied by the permission gate, so I did not retry it. Temp files from my tests remain under `$TMPDIR` (outside the repo).
- Port 3917 is held by a process I can't see and didn't start. I left it alone and used port 3931 for my tests.
- `data/checks/` was created by the check runner. It is gitignored.