A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:22-50 — When the worker reclaims a job whose lease expired, it always starts a new attempt with no upper limit. That breaks the "up to 3 attempts in total" rule and the "`attempts` set to 3" rule.
   Evidence: `claimStmt` picks `status='running' AND lease_until < ?` and `claimUpdateStmt` always runs `attempts = attempts + 1`. Take a job that was on attempt 3 when the worker was killed or stopped. On restart it is claimed as attempt 4. With `failAttempts >= 4` it then fails with `attempts: 4`, because `job.attempt >= MAX_ATTEMPTS` is still true. With `failAttempts <= 2` it can complete on attempt 4 or later. Restarting the worker repeatedly while a job runs can push `attempts` up without limit.
   Fix: In `claim()`, if the reclaimed row has `attempts >= MAX_ATTEMPTS`, mark it `failed` with `error='transient failure'`, `result_output=NULL` and `attempts` capped at 3, instead of starting another attempt. Alternatively, on a graceful stop, put the in-flight job back yourself: set `status='queued'`, `attempts = attempts - 1` and `progress_completed=0`, guarded by the attempt number. That way a clean `SIGTERM` does not use up one of the job's attempts. Also guard the `failed` branch with `attempts = MAX_ATTEMPTS` semantics so `attempts` is never stored above 3.

2. [minor] src/worker.ts:16-20 — The heartbeat runs in a `setInterval` callback with no error handling. If `beatStmt.run` throws, for example `SQLITE_BUSY` after the 5 s `busy_timeout` while a write lock is held, the exception is uncaught and the whole worker process crashes. `/health` then reports `down` and no jobs are processed.
   Evidence: `writeHeartbeat` has no try/catch, and there is no `uncaughtException` handler.
   Fix: Wrap the body of `writeHeartbeat` in try/catch and log the error, matching how `claim()` failures are handled.

3. [minor] ui/index.html:53-56 — A numeric field that is empty or not a number is silently dropped from the request, so the API default is used. The spec says the form sends the field values so that the API's validation applies, but here a cleared or invalid `steps`/`failAttempts` field never produces a validation error.
   Evidence: `numberOrOmit` returns `undefined` when `el.value.trim()===''`. A `type="number"` input also reports `''` for unparseable text such as `abc`, so the job is created with `steps: 5` and no error is shown.
   Fix: Always include the field. Send `Number(raw)` when the field parses, and otherwise send the raw string, or `null` when it is empty. The API then rejects it and `form-error` lists the field.

4. [minor] src/server.ts:80 — The Content-Type check `/^application\/json\b/i` also accepts types that are not JSON, such as `application/json-patch+json` or `application/json-seq`, because `-` counts as a word boundary.
   Evidence: `\b` matches between `n` and `-`.
   Fix: Parse the media type (`contentType.split(';')[0].trim().toLowerCase()`) and require it to equal `application/json`.

5. [minor] src/server.ts:200-203 — `HEAD /api/jobs` returns `405`, but `HEAD` is accepted on `/health`, `/` and `/api/jobs/:id`. The routes are inconsistent, and a probe that uses `HEAD` gets `method_not_allowed` on a valid path.
   Evidence: Only `method === 'GET'` is checked for the list route, while the other GET routes use `isGet`.
   Fix: Use `isGet` for the list route as well.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
