A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:19-21 — The browser's built-in form validation stops many bad submissions before they reach the API, so `form-error` stays empty. The fields have `required`, `maxlength="1000"`, `min`/`max` and `step` attributes, and the form has no `novalidate`. The task says form submissions go to `POST /api/jobs` "so the API's validation applies", and that `form-error` shows the API's rejection with each offending field's name.
   Evidence: With steps = 50, failAttempts = 9, steps = 1.5 or an empty input, the browser blocks the `submit` event. No request is sent and nothing appears in `[data-testid="form-error"]`. `maxlength` also makes it impossible to type more than 1000 characters, so that rejection can never be shown either.
   Fix: Add `novalidate` to the `<form>`, or remove `required`, `maxlength`, `min`, `max` and `step`. Then every submission reaches the API and its 400 `fields` are shown. Also check that an empty steps box is sent as a value the API rejects or defaults sensibly. Right now `Number('')` becomes `0`, which is rejected; that is acceptable.

2. [minor] src/worker.ts:7,22,31 — Jobs recovered after a crash can exceed the 3-attempt cap. On restart, `running` rows go back to `queued` with `attempts` unchanged, and `claim()` always does `attempts+1`. The failure check is also `attempts >= 3`, not `== 3`.
   Evidence: If the worker is killed during attempt 3 (for example, `failAttempts: 2`, or a long `steps: 20` job on its third try), the job is reclaimed as attempt 4. The task says "up to 3 attempts in total". If the job then fails, it reports `attempts: 4`, but the task requires `attempts` = 3.
   Fix: When claiming, if `attempts >= 3`, mark the job `failed` with `error='transient failure'` instead of starting another attempt. Alternatively, when recovering, decide whether the abandoned attempt counts toward the cap. Either way, keep a final `failed` job at `attempts` = 3.

3. [minor] src/server.ts:33-84 — The request handler is an `async` function with no try/catch. Any exception from SQLite (for example `SQLITE_BUSY` after the 5 s busy timeout, or a UNIQUE violation) becomes an unhandled promise rejection. On Node 22 that crashes the server process, and the request gets no response.
   Evidence: Line 73 rethrows after `ROLLBACK`. Lines 38 and 43 call `db.prepare(...)` unguarded. Line 64 only returns when `getJob` finds the job. If the idempotency row exists but the job row is missing, execution falls through to the insert, and the `INSERT INTO idempotency` on line 70 throws a primary-key error that kills the server.
   Fix: Wrap the handler body in try/catch and return `500 {"error":{"code":"internal_error",...}}`. Make the "prior key but missing job" case return an error instead of falling through to the insert.

4. [minor] src/server.ts:52-55 — The `Idempotency-Key` header is only checked after the body passes validation. When both the body and the key are invalid, the key is not reported, but the task says "each offending field listed in `fields`".
   Evidence: Sending `{"steps":"3"}` with the header `Idempotency-Key: bad key!` returns fields for `input` and `steps` only, with no `Idempotency-Key` entry.
   Fix: Validate the header first and merge its field error into the same `fields` array as the body validation, so all problems are returned in one 400.

5. [minor] src/worker.ts:46-56 — An exception in `claim()` or `processJob()` (for example a busy or locked database) leaves the loop through `finally` and the worker process exits. Health then reports `down` and queued jobs stop being processed.
   Evidence: `processJob` and `claim` have no error handling inside the loop. `claim` only rolls back and rethrows.
   Fix: Inside the loop, catch errors per iteration, log them, sleep briefly and continue. Only exit when `stopping` is set.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
