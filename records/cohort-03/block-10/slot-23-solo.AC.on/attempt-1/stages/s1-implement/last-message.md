The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. Nothing is committed.

**What's in place**
- **`src/db.ts`**: opens the database (creating its directory), enables WAL and a busy timeout, and creates the `jobs`, `idempotency` and `heartbeat` tables.
- **`src/jobs.ts`**: validation that collects every offending field, and the public job shape.
- **`src/server.ts`**: `/health`, `GET`/`POST /api/jobs`, `GET /api/jobs/:id`, `GET /`, and the 404/405 handling. Idempotency runs in a single `BEGIN IMMEDIATE` transaction, so a key creates at most one job. On SIGTERM it closes connections and exits.
- **`src/worker.ts`**: picks up the oldest queued job that is due, runs its steps with progress written after each one, and handles the retry rules. It writes a heartbeat every second and exits on SIGTERM.
- **`ui/index.html`**: the form and job list with the required `data-testid` values. It polls every 500 ms and sets all text with `textContent`.

**Choices I made where the spec was open**
- Retry delay is a fixed 500 ms, inside the 250 ms–2 s window.
- A blank `steps` or `failAttempts` field in the UI is left out, so the default applies. Non-numeric text is sent as-is so the API rejects it.
- A missing or wrong `Content-Type`, malformed JSON, and an oversized body (over 64 KB) all report the field `"body"`.
- On worker start, any job left `running` goes back to `queued`. A job interrupted by a graceful stop is also requeued.

**Verification**
- Manual runs on a fresh database: `failAttempts: 2` completes on attempt 3, `failAttempts: 3` ends `failed` with `transient failure`, and the idempotency replay returns 200 then 409.
- Data survived a SIGKILL of both processes and a restart, and replay still works afterward.
- Both processes exit on SIGTERM.

**Not verified**
- I did not run the page in a browser, so the UI is checked only by reading the code.
- The hidden evaluation is not run here.

**Things to know**
- During my first manual test, port 3917 was already held by another process with its own database. My server failed to bind there, so the first responses came from that process. I did not touch it, and I reran on a free port.
- `git status` shows untracked files I did not create (`.bashrc`, `.gitconfig`, `.github`, `scripts`, and others). I left them alone and did not add them to any commit.