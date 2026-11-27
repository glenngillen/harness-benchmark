The job tracker is implemented. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass.

I also ran the server and worker by hand on a free port with a fresh database, and covered the cases the fixed checks don't:

- **Validation:** each case in the plan returns 400 with the expected field, and the job count stays unchanged. Covered: missing or wrong Content-Type, malformed JSON, a non-object body, whitespace-only input, numeric strings, out-of-range and fractional steps, unknown fields, and a bad `Idempotency-Key`.
- **Retries:** failAttempts 1 and 2 complete on attempts 2 and 3. failAttempts 3 ends `failed` with `transient failure` after 3 attempts.
- **Idempotency:** replay returns 200 with the same id, a changed payload returns 409, and the replay still works after a SIGKILL restart of the server.
- **Crash recovery:** SIGKILL of the worker during a 20-step job. After restart it completes as `STRASSE` on attempt 1, and its `updatedAt` stays the same afterwards, so it was not reprocessed.
- **Health:** `worker` reports `down` after the worker is killed, and `up` again after a restart.
- **Shutdown:** SIGTERM makes both processes exit 0 in under 10 ms.

Things to know:

- **Port 3917 conflict:** my first run hit a server I did not start, because port 3917 was already in use on this machine. I discarded those results and reran on a dynamically chosen port. I did not touch the other process.
- **UI not verified in a browser:** I checked that the page serves with all the required `data-testid` attributes, but I did not exercise the submit or polling flow in a real browser.
- **Choices I made:**
  - A job that was `running` when the worker died has its interrupted attempt voided at startup, so it re-runs as the same attempt number. This keeps the attempt counting consistent with the retry rules.
  - Retries wait 500 ms.
  - Malformed JSON and non-object bodies are reported under the field `body`.
- **Changed files:** `src/db.ts`, `src/server.ts`, `src/worker.ts` and `ui/index.html`. Nothing is committed.