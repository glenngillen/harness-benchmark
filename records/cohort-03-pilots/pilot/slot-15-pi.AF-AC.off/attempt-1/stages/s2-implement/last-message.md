The job tracker is implemented. `npm run build`, `npm run check:smoke` and `npm run check:contract` all exit 0 (smoke 2/2, contract 5/5). I did not commit anything.

**What changed**
- `src/db.ts`: schema creation (`initSchema`), the `Job` shape and `rowToJob`, and the heartbeat helpers. `openDatabase` is unchanged.
- `src/server.ts`: the `node:http` router, body reading with a 1 MB cap, validation that reports every bad field, idempotency using a UNIQUE column, `GET /` serving the UI, and SIGTERM shutdown.
- `src/worker.ts`: startup recovery of `running` rows, a heartbeat every 500 ms, the claim loop in `BEGIN IMMEDIATE`, simulated failures with retries (500 ms delay, 3 attempts max), and graceful shutdown.
- `ui/index.html`: the form with the required `data-testid`s, `novalidate`, an alert region, and a list polled every second. It uses `textContent` only.

**Checked by hand against a fresh database**
- Create returns 201; progress climbs and the result is `HI`.
- `failAttempts` 2 completes with attempts 3. `failAttempts` 3 fails with `"transient failure"`.
- The validation cases return 400 with the named field, and no job is created.
- Idempotency: replay returns 200 with the same id, a different payload returns 409, and the replay still works after a server restart.
- Routing: 404 for unknown paths, 405 for wrong methods.
- `kill -9` on the worker mid-run: health shows `down` within 3 s, and after restart the job resumes and completes.
- SIGTERM on either process exits 0 in under 100 ms. The server survives `kill -9` with its jobs intact.

**Not verified**
- The browser UI. There is no browser in this environment. I checked that the inline script parses, that the `data-testid`s are present, and that the API it calls behaves correctly. Please open it in a browser once.

**Choices I made that you may want to change**
- A crash or graceful stop mid-attempt counts that attempt in `attempts`, because the attempt was started. So a job interrupted once and then completed reports `attempts: 2`.
- Unknown fields and a bad `Idempotency-Key` are reported alongside any other field errors in the same 400 response.
- Retry delay is a fixed 500 ms, within the allowed 250 ms–2 s range.

**Issue along the way**
- My first build had TypeScript errors, but `tsc` still emitted output, so the first check runs used stale output. I fixed the types, did a clean rebuild, and reran everything.

The untracked dotfiles and `scripts/` in the working tree were already there and I left them alone.