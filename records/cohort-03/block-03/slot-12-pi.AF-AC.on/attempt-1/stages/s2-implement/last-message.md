The job tracker is implemented in `src/db.ts`, `src/server.ts`, `src/worker.ts` and `ui/index.html`. `npm run build` is clean, `check:smoke` passes 2/2, and `check:contract` passes 5/5.

I also ran the server and worker as live processes on a free port with a fresh database and checked the behaviours from the plan:
- **Startup and health:** both processes start, and `/health` reports `worker: "up"`, then `"down"` about 3.5 s after the worker is killed.
- **Jobs:** `hi` completes as `HI`, and progress advances 2/20 → 19/20 while the job runs.
- **Validation:** each invalid case returns 400 and names the right field, and the job count does not change.
- **Idempotency:** 201, then 200 on replay, then 409 for a different payload. The replay still returns 200 after a restart.
- **Retries:** `failAttempts` 1 and 2 complete with 2 and 3 attempts, and 3 ends `failed` with `transient failure`.
- **Crash recovery:** after `kill -9` of the worker mid-run, the job completes with `attempts: 1`. After killing both processes and restarting, the job count is unchanged.
- **Routes:** unknown path returns 404 JSON, a wrong method returns 405 JSON, and `GET /` returns HTML.
- **Shutdown:** SIGTERM makes both processes exit with code 0.

**Things to know**
- My first live run was invalid. Port 3917 was already held by another process, so my server failed to start and the responses came from that process. I did not touch that process, and I reran on a free port.
- I did not check the browser UI interactively. I checked the API responses it depends on, and the inline script parses. The form-error path shows the field name, because the API error text includes it.
- Header and body errors are collected into one `fields` list, so a bad `Idempotency-Key` is reported alongside body errors.

Only `src/` and `ui/` changed, and I did not commit anything.