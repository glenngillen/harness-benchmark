The job tracker is implemented. It builds cleanly, both fixed checks pass, and I verified the behaviours in the plan against live processes. Nothing is committed.

**Checks**
- `npm run build`: exits 0.
- `npm run check:smoke`: 2/2 passed.
- `npm run check:contract`: 5/5 passed.

**Live verification** (scratch script in `$TMPDIR`, not in the repo):
- Health reports `up` with the worker running, and `down` about 3 s after `kill -9`.
- Create and complete returns 201, then `HELLO` after 3 steps.
- Validation: each bad case returns 400 and names the right field, including the `Idempotency-Key` and `body` cases. Job count is unchanged.
- Idempotency: replay returns 200 with the same id, a different payload returns 409, and the key still replays after a server restart.
- Retries: `failAttempts` 1 completes with attempts 2, 2 completes with attempts 3, and 3 ends `failed` with `transient failure`, attempts 3, result null.
- Crash recovery: `kill -9` on the worker during a 20-step job, then restart. The job completes as `LONGJOB`.
- Routes: unknown path gives 404 `not_found`, and `DELETE /api/jobs` gives 405.
- Both processes shut down cleanly on SIGTERM.

**Changes**
- `src/db.ts`: schema (`jobs`, `worker_heartbeat`), `rowToJob`, `nowIso`. The schema is created by `openDatabase`.
- `src/server.ts`: a `node:http` router, validation that collects all field errors, transactional idempotency, health, `/` serving the UI, and SIGTERM handling.
- `src/worker.ts`: a heartbeat timer, startup recovery, a claim loop in `BEGIN IMMEDIATE`, step progress, retries with `run_after`, and graceful shutdown that requeues an in-flight job.
- `ui/index.html`: the form with `novalidate`, the `role="alert"` error region, and a 1 s poll that updates existing list items in place. All text is set with `textContent`.

**Deviations from the plan**
- **Crash recovery does not decrement `attempts`.** The plan decremented it. The spec defines `attempts` as attempts *started*, and an interrupted attempt was started. So a job killed mid-run reports one higher `attempts` than the plan would give. The final outcome (completed or failed per the retry rules) is the same either way.
- **Graceful shutdown also requeues without decrementing**, for the same reason.
- The `steps` and `failAttempts` UI fields are `type="text"` rather than `type="number"`. A number input would silently turn non-numeric text into an empty value, so the API would never see it.

**Not verified**
- I did not open the page in a real browser. The UI behaviour is checked by reading the code, not by a DOM test.
- Two worker processes running at once is not handled. The spec assumes one.