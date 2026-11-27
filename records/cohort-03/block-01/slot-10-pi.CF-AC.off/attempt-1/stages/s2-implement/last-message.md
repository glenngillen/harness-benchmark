The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2), and `npm run check:contract` (5/5) all pass. I did not commit anything.

**What changed**
- `src/jobs.ts` (new): the job type, validation that collects every bad field, the `Idempotency-Key` check, and processing constants.
- `src/db.ts`: schema created with `IF NOT EXISTS` from either process, a row-to-job mapper, a store with prepared statements, `BEGIN IMMEDIATE` submission and claim transactions, and a separate heartbeat table.
- `src/server.ts`: routing with 404/405 JSON envelopes, byte-level body reading, idempotent submission (201/200/409), `/health` based on the heartbeat, and graceful SIGTERM/SIGINT shutdown.
- `src/worker.ts`: heartbeat every 500 ms, sequential processing with 100 ms steps, retries with a 500 ms persisted deadline, failure at attempt 3, and resume of a `running` row after a crash without incrementing attempts.
- `ui/index.html`: the form and list with every required `data-testid`, DOM-only rendering with `textContent`, 500 ms polling without overlap, and field-level error display.

**Checked by hand (against fresh databases on a free port)**
- Validation: unknown fields, numeric strings, fractions, nulls, whitespace-only input, non-JSON content type, malformed JSON, non-object bodies, and a bad key all return 400 with the right fields.
- Idempotency: the same key with defaults omitted or explicit returns 201, then 200, 200; a different payload returns 409.
- Retries: `failAttempts` 0, 1, and 2 complete on attempts 1, 2, and 3; 3 and 5 end `failed` with `transient failure` after 3 attempts.
- Health: `worker` goes from `up` to `down` about 3 s after SIGKILL and returns to `up` on restart.
- Recovery: a worker SIGKILLed while on attempt 3 resumed with `attempts` still 3 and completed the job.
- Non-ASCII input preserves whitespace and uppercases correctly (`ß` becomes `SS`).

**Not verified**
- The browser page was not run in a real browser; I checked it only by reading it.
- I did not test a SIGKILL during step progress for a job that succeeds on its first attempt. The probe landed on a failing attempt, so that path rests on code reading.
- I did not run concurrent same-key requests.

**Things to know**
- Port 3917 was already held by a process I did not start, and it answered my first test run. I left it alone and used port 4817.
- Some files in the repo root (`.bashrc`, `.zshrc`, `.idea/`, and others) were already untracked before I started. I did not touch them.