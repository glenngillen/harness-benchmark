The job tracker is built. `npm run build`, `check:smoke` (2/2), and `check:contract` (5/5) all pass. I also ran the server and worker against a scratch database to cover what the fixed checks don't.

**What changed** (only `src/` and `ui/`; nothing committed)
- **`src/db.ts`**: opens SQLite in WAL mode, creates the `jobs` and `worker_heartbeat` tables, and adds an `inTransaction` helper.
- **`src/jobs.ts`** (new): constants, the job JSON mapping, and request validation that collects every offending field.
- **`src/server.ts`**: routes, `POST /api/jobs` with idempotency, `GET` list and single job, `/health` based on the worker heartbeat, and graceful `SIGTERM`.
- **`src/worker.ts`**: requeues jobs left `running` at startup, writes a heartbeat every second, claims the oldest eligible job, runs steps of 100 ms with progress written after each step, retries with a 500 ms delay, and stops cleanly on `SIGTERM`.
- **`ui/index.html`**: the form and job list with all the required `data-testid`s. It polls every second and renders all text with DOM nodes, not HTML.

**Checked by hand**
- `failAttempts: 5` ends `failed` with `attempts: 3` and `error: "transient failure"`. `failAttempts: 2` completes on attempt 3.
- Validation rejects unknown fields, numeric strings, a non-JSON content type, malformed JSON, and bad idempotency keys, each naming the field.
- Idempotency returns 201, then 200 for the same payload, then 409 for a different one.
- A worker killed with SIGKILL mid-job finishes after restart as attempt 2, about 2.3 s later.
- Both processes exit 0 on SIGTERM, and health reports `worker: down` after the worker stops.

**Choices you may want to redirect**
- A crash counts as a started attempt, which follows the spec's wording. If a job is interrupted during its third attempt, it is marked `failed` with `"transient failure"` on recovery rather than rerun, to keep the three-attempt cap.
- A graceful `SIGTERM` in the middle of a job puts the job back in `queued`, with progress reset.
- In the UI, blank `steps` or `failAttempts` fields are omitted so the API defaults apply. Anything non-numeric is sent as typed, so the API rejects it and the error names the field.

One note on my testing: a background server and worker from my manual run are still up on port 3917. Their task has a 15-minute limit, so they will stop on their own.