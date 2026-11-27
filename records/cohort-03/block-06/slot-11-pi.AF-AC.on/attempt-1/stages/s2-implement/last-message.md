The job tracker is implemented in `src/db.ts`, `src/server.ts`, `src/worker.ts` and `ui/index.html`. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. Nothing is committed.

I followed the plan's design: shared SQLite in WAL mode, a single-row heartbeat table, `BEGIN IMMEDIATE` claims, `run_after` for retry delays, startup recovery of `running` jobs, and idempotency keys stored on the job row.

I exercised the behaviours by hand against a scratch database, with the server and worker as separate processes:

- **Health:** `worker: down` with no worker, `up` once the worker starts, and `down` about 3 s after `kill -9`.
- **Validation:** every case in the plan returns 400 naming the right field. `GET /api/jobs` count is unchanged afterwards. A 1000-character input is accepted and 1001 is rejected. An oversized body is rejected.
- **Idempotency:** same key and payload returns 201 then 200 with the same id. A different payload returns 409. The key still replays with 200 after a `kill -9` and restart of the server.
- **Progress:** `progress.completed` rises step by step to 20/20, and the output is upper-cased with `attempts: 1`.
- **Retries:** `failAttempts: 2` completes on attempt 3. `failAttempts: 3` ends `failed` with `transient failure`, `result: null`, and `attempts: 3`.
- **Crash recovery:** a job at 6/20 when the worker was killed with `kill -9` completes after restart. A completed job's `updatedAt` does not change across a restart.
- **SIGTERM:** both processes exit 0.
- **UI:** every required `data-testid` is present, and the page's inline script passes a syntax check. I did not run the page in a real browser, so the live update behaviour and the `form-error` display are unverified.

Choices I made where the plan or task left room:

- A repeated `Idempotency-Key` header is joined with `", "` before the pattern check, so it is rejected.
- On recovery, the interrupted attempt is re-run under the same attempt number, so `attempts` never exceeds 3 for a job.
- The UI also shows each job's input text, without a `data-testid`.

The scratch databases and the `data/checks` run directories are under gitignored paths. The untracked dotfiles and `scripts/` were already in the workspace, and I did not touch them.