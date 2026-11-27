The job tracker is implemented and the build passes. `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) both pass. I also ran the server and worker by hand to cover what the checks don't.

**What I changed** (only `src/` and `ui/`; nothing committed):
- **`src/db.ts`**: opens the database as before and creates the `jobs` and `heartbeat` tables with indexes.
- **`src/server.ts`**: implements `/health`, `GET`/`POST /api/jobs`, `GET /api/jobs/:id`, and `GET /`, with validation, `Idempotency-Key` handling, and 404/405 routing. Idempotent replays are stored in the database, so they survive restarts.
- **`src/worker.ts`**: claims the oldest queued job, runs steps of 100 ms with progress written after each step, simulates `failAttempts` with retries, and writes a heartbeat every second. It shuts down on `SIGTERM`.
- **`ui/index.html`**: the form and job list with all the required `data-testid` hooks. It polls every second and shows API rejections in `form-error`, naming each offending field.

**Manual checks** (private port and database):
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- A job killed mid-run with `SIGKILL` completes after both processes restart.
- A key replayed after restart returns 200 with the same job. A different payload returns 409.
- Wrong Content-Type returns 400 on `body`, a wrong method returns 405, and an unknown path returns 404.

**Choices you may want to review:**
- **Interrupted attempts:** on startup, a `running` job is requeued and its `attempts` is decremented by one, so the interrupted attempt is rolled back and does not count. The alternative is to keep the count, which would make `attempts` show 2 after one crash. The rollback means a crash during attempt 3 gives the job a fresh 3rd attempt rather than failing it.
- **Retry delay:** fixed at 500 ms, inside the 250 ms–2 s window.
- **Form input:** `steps` and `failAttempts` are plain text fields, not number inputs, so non-numeric entries reach the API and its validation messages. An empty field is omitted, so the default applies.

**Not verified:** I did not test the page in a browser, only the server responses and the JavaScript by reading it.

**Environment note:** while testing on port 3917 I reached a process I did not start, so I moved to port 4551. I did not investigate that process. The untracked dotfiles in `git status` were already in the workspace and I did not create them.