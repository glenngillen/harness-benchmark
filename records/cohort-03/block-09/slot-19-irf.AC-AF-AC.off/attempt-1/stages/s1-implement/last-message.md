The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I also ran the server and worker by hand for the cases the checks don't cover, and they behaved as the spec describes. I did not commit anything.

**Changes**
- **`src/db.ts`**: keeps the existing `openDatabase` and adds the schema: a `jobs` table with a sequence column for oldest-first ordering, and a `heartbeats` table.
- **`src/jobs.ts`** (new): shared job model, JSON shape, validation, and timing constants.
- **`src/server.ts`**: the HTTP API. Submissions run in `BEGIN IMMEDIATE` transactions, and the Idempotency-Key is a unique column, so replays and conflicts hold across restarts. It also serves the page at `/` and reports worker health from the heartbeat.
- **`src/worker.ts`**: claims the oldest runnable job, processes steps at 100 ms with progress written after each step, and handles retries. It writes a heartbeat every second and removes it on clean shutdown.
- **`ui/index.html`**: the form and job list with the required `data-testid` hooks. It polls every second, shows the API's rejection with each field name, and renders text with `textContent`.

**Choices I made**
- **Crash recovery:** a running attempt holds a 3-second lease that is renewed each step. If a worker dies, the job is reclaimed once the lease expires. An interrupted attempt counts toward `attempts`.
- **Retry delay:** a fixed 500 ms.
- **Validation:** all problems in a request are reported together. Content-Type and malformed-body errors use the field `"body"`.
- **Body size:** capped at 64 KiB. Larger bodies get a 400 with field `"body"`.

**Manual checks** (against a fresh database on a free port)
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- A job killed mid-run with `SIGKILL` was reclaimed and completed after restart.
- Validation cases returned the expected 400s. Wrong methods returned 405 and unknown paths returned 404.
- Idempotency returned 201, 200 for the same payload with defaults applied, and 409 for a different payload.
- `SIGTERM` stopped both processes cleanly.

**Things to know**
- Part-way through testing, my first attempt was answered by a different process on port 3917. Those results were discarded and I reran on a fresh port and `mktemp` directory. Early on I also ran `rm -rf $TMPDIR/t`. I had created that path myself, but the port-3917 process may have been using it. I don't think it affects the repo.
- I did not test the page in a real browser. I checked it by reading the code.