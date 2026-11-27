The job tracker is implemented and runs. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. Nothing is committed; the changes are in the working tree.

**What changed**
- `src/jobs.ts` (new): public job types, validation (unknown fields, types, ranges, whitespace-only input, idempotency-key format), defaults applied only to absent fields, and the row-to-JSON mapping.
- `src/db.ts`: schema init (`CREATE ... IF NOT EXISTS`), a `BEGIN IMMEDIATE` transaction helper, idempotent submission, the claim, progress, retry, completion and heartbeat helpers.
- `src/server.ts`: routing with JSON 404/405, body parsing, validation before any DB write, `201`/`200`/`409` idempotency, `/health` based on a 3-second heartbeat freshness window, and bounded shutdown on SIGINT/SIGTERM.
- `src/worker.ts`: heartbeat every 500 ms on its own timer, a 100 ms claim poll, one step per 100 ms with progress persisted per step, the simulated failure at step 1, retries after 500 ms, and recovery of interrupted jobs on startup. Shutdown clears the heartbeat and exits.
- `ui/index.html`: the form and all required `data-testid` hooks, with DOM creation and `textContent` only. Polling is every 500 ms and serialized, so a slow response can't overwrite newer state.

**Choices I made**
- Recovery of an interrupted attempt uses a `resume` flag. The job is requeued with the same `attempts` value, so the three-attempt budget isn't consumed by a crash. This is the plan's approach.
- Retry delay is a fixed 500 ms.
- The browser page is verified by reading the markup and script, not by running it in a browser. I didn't have one available.

**Verification beyond the fixed checks** (probe scripts in `$TMPDIR`, not in the repo)
- Validation: malformed JSON, arrays, null, unknown fields, numeric strings, fractions, boundaries, multiple field errors together.
- Routing: 404 and 405 with JSON bodies.
- Exact input: whitespace and Unicode are preserved, and the output matches `toUpperCase()`.
- Retries: `failAttempts` 0–5 give the expected completions and terminal failures.
- Idempotency: replay, conflict, and 8 parallel same-key requests producing one job.
- Progress: observed one step at a time on an idle worker.
- Durability: SIGKILL mid-run resumes the same attempt and completes. SIGKILL during attempt 3 ends `failed` with `attempts: 3`.
- Heartbeat: `down` after the worker is killed, `up` after restart.
- Shutdown: both processes exit with code 0 on SIGTERM.

**Things to know**
- Port 3917 was already held by a process I don't control, so my first probe run talked to that process and its results were meaningless. I reran on port 4817 and then 4818. I didn't touch the other process.
- The `data/` directory created during testing is gitignored.