I built the job tracker: the API, the worker, and the browser page. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass.

I also ran both processes by hand against a fresh database and checked:
- **Retries:** a job with `failAttempts: 3` ended `failed` after 3 attempts with `"transient failure"`.
- **Crash recovery:** I killed the worker with `SIGKILL` in the middle of a 20-step job. `/health` changed to `"down"`, and after a restart the job finished as `LONG` with `attempts: 2`.
- **Error responses:** wrong `Content-Type`, a bad `Idempotency-Key`, a body that isn't an object, whitespace-only input, non-integer `steps`, a wrong method (405) and an unknown path (404) all returned the right code.
- **Shutdown:** both processes exit cleanly on `SIGTERM`.

I didn't test the page in a browser; the checks only cover the API and the processes.

**What changed:**
- **`src/db.ts`:** creates the `jobs` and `heartbeat` tables and converts database rows into the job JSON shape. Jobs are listed newest first in the order they were created.
- **`src/server.ts`:** all the routes, validation (each bad field is listed in `fields`), and idempotency. Idempotency keys are unique in the database and checked inside a locked transaction, so a key can't create two jobs, even across restarts. The replay comparison uses the payload after defaults are filled in. `/health` reports `"up"` if the worker's heartbeat is less than 3 seconds old.
- **`src/worker.ts`:** writes a heartbeat every 500 ms and checks for queued jobs every 100 ms. It takes the oldest job that is ready, and each step takes 100 ms with progress saved after every step. Failed attempts go back to `queued` and retry after 500 ms, up to 3 attempts in total. At startup and on `SIGTERM`, any job left `running` goes back to the queue.
- **`ui/index.html`:** the form, an error region listing each rejected field, and a job list with all the required `data-testid` attributes. The list refreshes every 500 ms. Number fields are sent as numbers, and anything that isn't a number is sent as typed so the API rejects it.

**Behaviours you might not expect:**
- **Interrupted job on its third attempt:** it's rerun as attempt 3 rather than counted as a fourth, so `attempts` never goes over 3. The catch is that `attempts` can briefly drop from 3 to 2 while the job waits in the queue.
- **One worker only:** at startup the worker assumes any `running` job belongs to a dead worker. If you ran two workers at once, they would take each other's jobs.

I haven't committed anything; the changes are in the working tree.