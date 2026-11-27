The job tracker is implemented. `npm run build` passes, `check:smoke` passes 2/2, and `check:contract` passes 5/5.

I also ran a disposable verification script against a fresh database in `$TMPDIR` (removed afterwards). It covered:

- **Validation:** every case in the validation list, with all offending fields reported and no jobs created on rejection.
- **Routing and idempotency:** 404 and 405 cases, idempotent replay, conflicts, and simultaneous same-key requests.
- **Processing:** retries for `failAttempts` 0, 1, 2, 3 and 5, 20-step progress and timing, and FIFO order.
- **Durability:** worker SIGKILL mid-attempt and mid-retry, interruption during attempt 3, and server SIGKILL with idempotent replay after restart.
- **Heartbeat and shutdown:** `worker` goes down within 3 s of SIGKILL and back up on restart; SIGTERM exits cleanly for both processes.

**Not verified:** the browser UI. No browser is installed here, so I only checked that the inline script parses and that all required `data-testid` attributes are present. Please exercise the page in a real browser before relying on it.

**Choices I made where the task and plan left room:**
- **Recovery:** the worker resumes any `running` row before claiming new work. It keeps the recorded attempt number, so recovery does not count as an extra retry.
- **Shutdown:** the worker clears its heartbeat row on SIGTERM, so health reports `down` immediately. The server closes idle connections, then forces remaining ones closed after 2 s.
- **Body limit:** request bodies are capped at 64 KB. Larger bodies get a `400` with field `body`.
- **Assumption:** recovery treats any `running` row as interrupted, which holds only for a single worker process.

**Files changed:** `src/db.ts`, `src/jobs.ts` (new), `src/server.ts`, `src/worker.ts`, and `ui/index.html`. Nothing else was modified and nothing was committed.