A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] ui/index.html:20-22 — The browser's own form validation stops bad submissions before they reach the API, so `form-error` never shows the API's rejection for them. The task says form submissions must go to `POST /api/jobs` so the API's validation applies.
   Evidence: `job-input` has `required maxlength="1000"`. `job-steps` and `job-fail-attempts` have `min`/`max`/`step="1"`. If the input is empty, steps is 0 or 25, or failAttempts is 9 or 1.5, the browser blocks the `submit` event. No request is sent and `form-error` stays empty, so an evaluator expecting e.g. "steps: …" in the alert gets nothing.
   Fix: Add `novalidate` to the `<form>`, or remove `required`, `maxlength`, `min`, `max` and `step`. Let the API reject the values and show its `fields` in `form-error`.

2. [major] src/worker.ts:9,46 — A crash during attempt 3 pushes `attempts` above 3. A failing job can then end with `attempts: 4` or more, but the task says a failed job has `attempts` set to 3, with "up to 3 attempts in total".
   Evidence: On startup, `running` rows go back to `queued` but keep their `attempts` count. Claiming the row again runs `attempts=attempts+1`. Example: `failAttempts: 5`, worker SIGKILLed while attempt 3 is running, worker restarts. The job gets `attempts=4`, and the failure check `job.attempts >= 3` then marks it `failed` with `attempts=4`. If the worker is killed again, the count keeps growing.
   Fix: When recovering a `running` job, either decrement `attempts` so the interrupted attempt is rerun, or, if `attempts >= 3`, finish it directly (`failed` if `attempts <= failAttempts`, otherwise process it without incrementing). Never let `attempts` go above 3.

3. [minor] src/server.ts:53-57 — Malformed JSON or a non-object body adds extra field errors. `body` is listed twice, and `input: Is required.` is also listed when the real problem is the whole body.
   Evidence: For `{bad`, the JSON parse fails and pushes `body`. `value` is then undefined, so `body` is pushed again ("Must be a JSON object"). Then `obj = {}`, which pushes `input` required. A check expecting `fields` to contain only `body` for malformed JSON or for `[]` would fail.
   Fix: If the parse fails or the value is not a plain object, return 400 straight away with just the `body` field (plus `Content-Type` and `Idempotency-Key` errors if they also apply). Skip the per-field checks.

4. [minor] src/server.ts:49 — A missing or non-JSON `Content-Type` is reported only as field `"Content-Type"`. The task says to use `"body"` when the body as a whole is the problem. A check might look for either name.
   Evidence: `fields.push({ field: 'Content-Type', ... })`, and `body` is not added in this case.
   Fix: Report it under `body` as well (or only under `body`), e.g. `{field:'body', message:'Content-Type must be application/json.'}`.

5. [minor] src/worker.ts:37-55 — The heartbeat is only written between jobs, never during `processJob`. A 20-step job runs about 2.0–2.2 s with no heartbeat. Slow SQLite writes or lock waits under `busy_timeout` could push the gap past 3 s, and `/health` would report `worker: "down"` while the worker is busy.
   Evidence: `heartbeat.run(Date.now())` is called only at the top of the main loop.
   Fix: Also write the heartbeat after each step in `processJob`, or on an independent `setInterval` of about 1 s (cleared on shutdown).

6. [minor] src/server.ts:30 — The request handler is `async`, and SQLite errors outside the insert try/catch are not caught. Examples: `SQLITE_BUSY` on the GET or SELECT paths, or a failing `toJob` JSON.parse. These become unhandled rejections, which crash the server on Node 22.
   Evidence: There is no try/catch around the handler body. `createServer` does not handle rejected promises.
   Fix: Wrap the handler body in try/catch and return `500 {error:{code:'internal_error',...}}`.

7. [minor] src/server.ts:108 — On SIGTERM the server calls `server.close()`, which waits for active connections to finish. A keep-alive connection that stays busy (for example, the UI polling every 500 ms) can delay shutdown.
   Evidence: `server.close(cb)` is called with no `closeAllConnections()` and no timeout fallback.
   Fix: Call `server.closeAllConnections()` (or `closeIdleConnections()`) after `close()`, and add a timeout fallback, e.g. `setTimeout(() => process.exit(0), 2000).unref()`.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
