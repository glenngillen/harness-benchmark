The job tracker is implemented. `npm run build` compiles cleanly, and both fixed suites pass (smoke 2/2, contract 5/5).

**What changed**
- **`src/db.ts`**: opens the SQLite database (WAL, busy timeout) and creates the `jobs`, `idempotency`, and `heartbeat` tables. It also maps rows to the public job JSON.
- **`src/server.ts`**: the HTTP API. It covers validation with per-field errors, the 404/405 routes, and idempotent creation in one `BEGIN IMMEDIATE` transaction. Health reads the worker heartbeat (up if ≤3 s old), and `GET /` serves the UI.
- **`src/worker.ts`**: on startup it requeues jobs left `running` by a dead worker. It then claims the oldest eligible queued job atomically, runs steps of 100 ms with a progress write after each step, and applies the failure and retry rules. It writes a heartbeat and exits cleanly on SIGTERM/SIGINT.
- **`ui/index.html`**: the form and job list with the required `data-testid` hooks. It polls every second and shows API rejections with each field name.

**Choices I made where the brief was open**
- Retry back-off is a fixed 500 ms, within the 250 ms–2 s range.
- A crash-interrupted attempt is handed back (`attempts` decremented) and re-run under the same attempt number. This keeps the 3-attempt limit exact after crashes. A job killed mid-run therefore shows `attempts: 1` once it completes.
- On graceful SIGTERM, an in-progress attempt is released back to the queue immediately.
- Request bodies over 64 KB are rejected as `invalid_request`.

**Verified by hand** (on a free port with an isolated database)
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- A `kill -9` during a 20-step job, followed by a worker restart, completes the job.
- Idempotent replay returns 200, a different payload returns 409, and invalid bodies return the expected 400 fields.
- Unknown paths return 404, and wrong methods return 405.
- Both processes exit on SIGTERM.

**Not verified**
- I did not load the page in a real browser. I confirmed only that `GET /` serves the HTML.
- Durability across a `kill -9` of the server, and the idempotency guarantee across a server restart, were not run as separate tests. The state lives in SQLite, but I did not exercise those cases directly.

**Things to know**
- My first manual run hit `EADDRINUSE` on port 3917, because another process was already listening there. I discarded those results and reran on a free port.
- `git status` shows untracked dotfiles and directories (`.bashrc`, `.github`, `scripts`, and others) that I did not create. I left them alone.