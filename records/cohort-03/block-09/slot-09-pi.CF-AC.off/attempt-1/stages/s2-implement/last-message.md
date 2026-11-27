The job tracker is implemented. `npm run build` exits 0, and both supplied suites pass (smoke 2/2, contract 5/5).

**What changed**
- `src/db.ts`: opens the database as before, then creates the `jobs` and `heartbeat` tables. Adds an `immediate()` helper for short `BEGIN IMMEDIATE` transactions.
- `src/jobs.ts` (new): job types, the single serializer, and request validation. Validation collects every error, applies defaults only to absent fields, and builds the normalized payload used for idempotency.
- `src/server.ts`: routing, JSON errors, idempotent creation (the lookup and insert share one transaction), health from the worker heartbeat, and a bounded shutdown on SIGTERM/SIGINT.
- `src/worker.ts`: claims the oldest eligible queued job, runs 100 ms steps with progress written after each one, and schedules retries 500 ms ahead in SQLite. It writes a heartbeat every 500 ms and clears it on shutdown. On startup it replays any `running` job without incrementing `attempts`.
- `ui/index.html`: the form, error region, and job list with every required `data-testid`. Polling is non-overlapping at 500 ms, and all user text goes in via `textContent`.

**Verified beyond the supplied checks**
- Validation: malformed JSON, non-object bodies, wrong content type, unknown fields, numeric strings, fractions, explicit nulls, bad keys, and multiple errors in one request. Each reports the right field names.
- Idempotency: default-equivalent replay returns 200, changed payloads return 409, and eight concurrent submissions with one key produce a single job.
- Retries: `failAttempts` 1 and 2 complete on attempts 2 and 3 with ~500 ms queued delays. 3 and 5 end `failed` with `"transient failure"` after 3 attempts.
- Durability: SIGKILL of the worker during a successful third attempt. Health reports `down`, and after restart the job resumes with `attempts` still 3 and completes. SIGTERM exits both processes with code 0 in about 20 ms.
- Startup: both processes start together against a fresh nested `DATABASE_PATH`.
- Routing: unknown paths and missing IDs return JSON 404, and wrong methods on known paths return 405.

**Not verified**
- I did not drive the page in a real browser. I checked that `/` serves the markup and that the inline script parses.
- The `attempts` and `progress` semantics are my reading of the spec for recovered attempts: a replayed attempt keeps its number and restarts progress at 0.

**Choices I made**
- Blank or non-numeric steps and failAttempts fields are sent as strings, so the API rejects them instead of the form turning them into 0.
- Bodies over 16 KiB get a `400` with field `body`.
- An unexpected server error returns `500 internal_error`, a code the spec does not list.

I also left the scratch test scripts in `$TMPDIR`, not in the repo. The repo's only new file is `src/jobs.ts`. `data/` is created by the supplied check runner.