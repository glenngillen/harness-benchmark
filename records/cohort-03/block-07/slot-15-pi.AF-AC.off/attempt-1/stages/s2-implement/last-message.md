The job tracker is implemented. `npm run build` passes, both `check:smoke` (2/2) and `check:contract` (5/5) pass, and I also exercised the behaviours the checks don't cover on private ports.

**What I changed** (only `src/` and `ui/`; nothing fixed was touched, and I haven't committed):
- `src/db.ts`: schema creation (`jobs`, `worker_heartbeat`) on open, the row-to-JSON mapper, `nowIso()`, and a `tx()` helper that uses `BEGIN IMMEDIATE`.
- `src/validate.ts` (new): pure submission validation that collects every field error.
- `src/server.ts`: routing with JSON 404/405/500, the create/list/get endpoints, idempotency inside a write transaction, `/health` from the heartbeat, and SIGTERM/SIGINT shutdown.
- `src/worker.ts`: heartbeat every 500 ms, requeue of interrupted `running` jobs at startup, a 200 ms idle poll, per-step progress, retries at 500 ms with a 3-attempt cap, and clean shutdown.
- `ui/index.html`: the form, the `form-error` alert, and the job list with the required `data-testid`s, polling every second with `textContent` rendering.

**Verified by running it:**
- Validation: each invalid case in the plan returns 400 with the right `fields[].field`, and no job is created.
- Idempotency: 201 then 200 with the same id, 409 on a different payload, and the replay still returns 200 after a server restart.
- Progress rises across polls (`1/10`, `4/10`, then completed).
- Retries: `failAttempts:2` completes with attempts 3; `failAttempts:3` fails with `"transient failure"`, attempts 3, and a null result.
- Crash recovery: `kill -9` on the worker mid-run; `/health` reports `down` after about 3.5 s; a restarted worker completes the job with attempts 1. `updatedAt` stays the same on a completed job.
- SIGTERM: both processes exit with code 0.

**Choices where I departed from the plan or had to decide:**
- The `steps` and `failAttempts` fields are `type="text"` with `inputmode="numeric"`, not `type="number"`. Browsers blank non-numeric text in number inputs, so the API would never see a bad value.
- An empty numeric field is omitted, so the server default applies (the plan's choice).
- Retry delay is 500 ms; a failed attempt fails immediately, before any progress.
- Recovery and shutdown requeue a claimed job with `attempts - 1`, so an interrupted attempt is not counted twice.

**Not verified:** I did not open the page in a real browser. I checked that the test IDs are present and that the API behaviour the page depends on works.