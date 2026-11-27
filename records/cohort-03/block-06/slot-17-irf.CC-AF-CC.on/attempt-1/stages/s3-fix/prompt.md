A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:18-21 — The browser's own form validation blocks submissions before they reach the API. The task says the form must send its values to `POST /api/jobs` so that the API's validation applies, and `form-error` must show the API's rejection with each offending field's name.
   Evidence: `job-input` has `required minlength maxlength`. `job-steps` has `min="1" max="20"`, `job-fail-attempts` has `min="0" max="5"`, and both use type=number with the default step of 1. If the evaluator enters steps `25`, steps `0`, failAttempts `9`, a decimal like `1.5`, or an empty input, the browser stops the submit and shows its own tooltip. `fetch` is never called and `form-error` stays empty, so any UI check for "rejection shows field name" fails.
   Fix: add `novalidate` to the `<form>`, or remove the `required/minlength/maxlength/min/max` attributes, so every submit goes to the API and the 400 `fields` are rendered.

2. [minor] src/server.ts:29-103 — The request handler is an `async` function with no top-level try/catch. Any exception other than a body-parse error becomes an unhandled promise rejection, and on Node 22 that kills the server process. It also never sends a JSON response.
   Evidence: line 94 does `ROLLBACK; throw e`. Line 80's `BEGIN IMMEDIATE` can throw `SQLITE_BUSY` if the worker holds the write lock past `busy_timeout`. Any `getJob` or `prepare` error does the same. None of these are caught.
   Fix: wrap the handler body in try/catch, and in the catch send `500 {"error":{"code":"internal_error","message":...}}` (only if `!res.headersSent`).

3. [minor] src/worker.ts:16-19 — Crash recovery can push `attempts` past 3, against the rule of "up to 3 attempts in total".
   Evidence: take a job with `failAttempts: 2` that is interrupted during attempt 3, or any job with `attempts` already at 3 and `attempts > fail_attempts`. The third UPDATE requeues it, and the next claim sets `attempts = 4`. Repeated kills of a `failAttempts: 0` job also raise `attempts` every time without limit.
   Fix: when requeuing a non-failing interrupted attempt, decrement `attempts` (`attempts = attempts - 1`) so the restarted attempt reuses its number. Or explicitly cap the claim so `attempts` never goes above 3.

4. [minor] src/server.ts:47-49 — When the `Content-Type` is wrong and the body is also malformed, `fields` gets two separate `body` entries.
   Evidence: line 47 pushes `{field:'body'}`, then line 49 pushes another `{field:'body'}` on a JSON parse failure.
   Fix: skip the second push if a `body` field already exists (the same guard as line 51), or merge the messages into one entry.

I could only read the code in this session. I did not build, start or call the app, so none of these were confirmed by running it. Apart from the points above, I found nothing wrong in the code for routing, validation, idempotency (including the in-transaction re-check), heartbeat and `/health`, claiming, step timing, retry delays, the final failure state, the UI polling interval or the `data-testid` markup.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
