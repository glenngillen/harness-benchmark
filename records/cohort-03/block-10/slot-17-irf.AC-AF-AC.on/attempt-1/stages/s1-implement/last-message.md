The job tracker is implemented. `npm run build`, `check:smoke` (2/2), and `check:contract` (5/5) all pass. I did not commit the changes.

**What changed**

- **`src/db.ts`**: Opens SQLite in WAL mode and creates the `jobs` and `worker_heartbeat` tables.
- **`src/jobs.ts`** (new): Validation with per-field errors, defaults, and the job JSON mapping.
- **`src/server.ts`**: Routing with 404/405, JSON body parsing with the `Content-Type` check, idempotency inside a `BEGIN IMMEDIATE` transaction backed by a UNIQUE key column, and `/health` based on a heartbeat younger than 3 s. It serves the UI and shuts down on SIGTERM/SIGINT.
- **`src/worker.ts`**: Recovers `running` jobs to `queued` at startup, writes a heartbeat every second, and claims the oldest eligible job. Each step is 100 ms with progress written per step. Failed attempts are requeued with a 500 ms delay, and the third failure ends `failed` with `"transient failure"`.
- **`ui/index.html`**: The form and job list use the required `data-testid` values. The page polls every second and builds the DOM with `textContent`, so job input can't inject markup.

**Manual checks beyond the fixed suites** (on a fresh database and port)

- An idempotent replay returns 200, and a different payload under the same key returns 409.
- `failAttempts: 3` ends `failed` with `attempts: 3`.
- SIGKILL on the worker makes `/health` report `worker: down`. After restart it reports `up`, and the interrupted job completes.
- Unknown routes return 404, wrong methods return 405, and SIGTERM stops both processes cleanly.

**Choices I made where the spec was open**

- A job interrupted mid-run keeps its `attempts` count. Its re-run counts as the next attempt, so `attempts` means attempts started.
- Empty form fields are omitted, so the API defaults apply. Non-numeric text is sent as typed so the API rejects it and names the field.
- Request bodies are capped at 64 KB, and the retry delay is 500 ms.
- Recovery assumes a single worker process.

**Things to know**

- A process from my first test run still holds port 3917. I couldn't see or kill it from this shell. It is harmless to the grader's port but may be worth stopping manually.
- `git status` shows untracked dotfiles and directories (`.bashrc`, `.github`, `scripts`, and others) that were already in the workspace. I didn't create them and didn't touch them.