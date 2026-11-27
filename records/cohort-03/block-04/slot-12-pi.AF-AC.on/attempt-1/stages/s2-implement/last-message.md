The job tracker is implemented in `src/db.ts`, `src/server.ts`, `src/worker.ts`, and `ui/index.html`. `npm run build`, `check:smoke` (2/2), and `check:contract` (5/5) all pass. I did not commit.

**Incident to know about:** my first manual test run hit a process I didn't start. A mistake in my test script left `DATABASE_PATH` empty, so my server and worker crashed, and my requests went to an unrelated service already listening on port 3917. That service accepted a few test POSTs (for example input `ok` and idempotency key `K1`), so it may contain stray test jobs. I did not touch that process. I then re-ran everything on port 4817/4818 with scratch databases in `/tmp`, and all of the results below come from those runs.

**Verified against a live server and worker:**
- **Validation:** every case in the plan gives 400 `invalid_request` with the right `fields` entry. Unknown routes return 404 and wrong methods return 405.
- **Idempotency:** same key and payload returns 200 with the same job; a different payload returns 409. The replay still returns 200 after a server restart.
- **Progress:** a 20-step job moves through `running` with progress increasing to `completed`, output `HELLO WORLD`.
- **Retries:** `failAttempts` 0, 1, 2 complete on attempts 1, 2, 3. `failAttempts: 3` ends `failed` on attempt 3 with `transient failure`.
- **Crash recovery:** `kill -9` during a run, then a worker restart, completes the job with `attempts: 1`.
- **Health:** `worker` is `up` after startup and `down` after `kill -9`.
- **SIGTERM:** both processes exit 0.

**Not verified:** the browser UI. No browser or DOM library is installed, so I checked the page logic by reading it. The `data-testid` elements, the 1-second polling, and the `form-error` behaviour need a real browser check.

**Choices I made within the plan:**
- Crash recovery and shutdown put an interrupted attempt back as `queued` with `attempts` decremented. The attempt is then re-run under the same number, so `attempts` never exceeds 3.
- The worker deletes its heartbeat row on a clean shutdown, so health reports `down` at once.
- A 405 response includes an `Allow` header.
- Every non-2xx response uses `Content-Type: application/json`.