The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. I also ran the server and worker by hand and checked the behaviour the contract checks don't cover.

**What changed (all under `src/` and `ui/`):**
- `src/db.ts`: opens SQLite in WAL mode, creates the schema (`jobs`, `idempotency`, `heartbeats`), and provides row helpers, a transaction helper and the job-to-JSON mapping.
- `src/validate.ts` (new): request-body validation. It returns every offending field in one response.
- `src/server.ts`: routes, the job endpoints, idempotency inside a `BEGIN IMMEDIATE` transaction, `/health` based on a worker heartbeat younger than 3 s, and the `/` page. On SIGTERM it closes connections and the DB, then exits.
- `src/worker.ts`: claims the oldest runnable job atomically with `UPDATE ... RETURNING`, runs 100 ms steps with progress written after each one, and handles transient failures by requeuing with a random 250–2000 ms `run_after` delay. It writes a heartbeat every second. On start it requeues any jobs left `running`. On SIGTERM it stops between steps.
- `ui/index.html`: the form and job list with the required `data-testid` attributes. It polls `/api/jobs` every second and shows API rejections, including field names, in `form-error`.

**Manual checks I ran:**
- `failAttempts: 3` ends `failed` with `attempts: 3` and error `"transient failure"`.
- Unknown fields, `"3"` as a string, malformed JSON, a non-object body, a missing Content-Type, a bad Idempotency-Key, and a wrong method or unknown path all return the specified errors.
- Idempotent replay returns 200, and a changed payload returns 409.
- After `kill -9` of both processes mid-job and a restart, the job completed. SIGTERM exits both cleanly.

**Choices I made where the spec was open:**
- Content-Type and body-size problems use the field name `"body"`. A bad `Idempotency-Key` uses `"Idempotency-Key"`.
- Bodies over 64 KB are rejected with `invalid_request`.
- The worker requeues `running` jobs on startup. The interrupted attempt stays counted in `attempts`.
- I did not load the page in a real browser. I only checked that its inline script parses.

**Not mine:** `git status` shows untracked dotfiles at the workspace root (`.bashrc`, `.zshrc`, `.github`, `scripts`, and others). They look like sandbox bind mounts, and I did not create or touch them.