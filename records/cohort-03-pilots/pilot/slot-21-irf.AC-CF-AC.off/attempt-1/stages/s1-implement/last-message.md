The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass.

**What I checked by hand, beyond the fixed suites:**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- Killing the worker with SIGKILL makes `/health` report `worker: "down"` within about 3 seconds.
- A job killed mid-run after one failed attempt was picked up after restart and completed about 5 seconds later.
- Invalid bodies, the idempotency replay and conflict paths, 404 and 405 responses, and the UI `data-testid` set all behave as specified.
- Both processes exit on SIGTERM.

**Design choices:**
- **Schema:** one `jobs` table plus a `heartbeat` table, in SQLite WAL mode. Both processes share the same `DATABASE_PATH`.
- **Worker lease:** a running job holds a 3-second lease that each step renews. If the worker dies, the lease expires and the job is reclaimed. This avoids reprocessing a job that another live worker is still running.
- **Retry delay:** a fixed 500 ms between attempts, within the 250 ms to 2 s range.
- **Graceful shutdown:** the worker hands an in-progress job back to `queued` rather than leaving it stuck in `running`.
- **Idempotency:** the key is a unique column, and the check and insert run in one `BEGIN IMMEDIATE` transaction.
- **UI:** an empty step or fail-attempts field is sent as the raw empty string, so the API rejects it. I chose that over silently applying the default.
- **Validation:** all field errors are reported together in `fields`.

**Things to be aware of:**
- A crash-interrupted attempt still counts toward `attempts`, so a job killed mid-run shows `attempts: 3` after its successful retry. I read "attempts started" literally; say if you want interrupted attempts not to count.
- The repo root has untracked dotfiles and folders (`.bashrc`, `.gitconfig`, `.github`, `.vscode`, `scripts`, and others) that I did not create. I left them alone. They are not part of this change.
- I have not committed anything.