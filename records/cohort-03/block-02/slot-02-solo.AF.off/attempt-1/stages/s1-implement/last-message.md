The job tracker is built and works. `npm run build` compiles cleanly, and the smoke check (2/2) and contract check (5/5) both pass. I also ran manual tests:
- **Abrupt kill:** I killed the worker with `SIGKILL` partway through a job. `/health` switched to `"worker":"down"`, and after a restart the job ran again and completed.
- **Permanent failure:** a job with `failAttempts: 3` ended `failed` with `attempts: 3` and `error` set to `"transient failure"`.
- **Errors:** wrong methods got 405, unknown paths got 404, and bad input got 400 with every offending field listed (including `Idempotency-Key`, `Content-Type` and `body`).
- **Shutdown:** both processes stopped cleanly on `SIGTERM`.

I didn't try the browser page in a browser, and I haven't committed anything.

**What changed:**
- **`src/db.ts`:** creates the `jobs` table (with a unique idempotency key and a "retry after" time) and a one-row heartbeat table, and converts stored rows into the job JSON shape.
- **`src/server.ts`:** all the endpoints, routing and validation. Idempotency is checked inside a database transaction, so one key can't create two jobs, even across restarts.
- **`src/worker.ts`:**
  - Writes a heartbeat every 500 ms.
  - Picks the oldest queued job every 100 ms.
  - Each step takes 100 ms and progress is saved after each one.
  - A failed attempt goes back to `queued` and is retried after 500 ms; the job fails after 3 attempts.
  - On startup it re-queues any job left `running` by a dead worker.
  - On `SIGTERM` it hands back the current job and clears its heartbeat.
- **`ui/index.html`:** the form, error box and job list with all the required `data-testid` attributes, refreshing every 500 ms. The form has no browser-side limits, so out-of-range values reach the API and its errors are shown.

**Choices where the spec was unclear:**
- **Missing or wrong `Content-Type`:** the error lists both `Content-Type` and `body` as fields.
- **Killed worker:** the interrupted attempt still counts, so a job killed during attempt 1 finishes with `attempts: 2`. To keep the 3-attempt limit, the count is capped at 3.
- **Normal shutdown (`SIGTERM`):** the interrupted attempt is not counted.