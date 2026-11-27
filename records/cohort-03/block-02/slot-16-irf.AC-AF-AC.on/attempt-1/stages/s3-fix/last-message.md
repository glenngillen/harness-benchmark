All five findings were correct, and I fixed all five. The build passes, smoke passes 2/2, and contract passes 5/5. I also re-ran targeted checks on each change, but not the full earlier end-to-end script: its scratch directory disappeared, so I couldn't rerun it.

Changes:

1. **Attempt cap on reclaim (`src/worker.ts`).** A job reclaimed after a crash now gets `min(attempts + 1, 3)`, so stored `attempts` never exceeds 3. I did not follow the reviewer's suggestion to mark such a job `failed`. Attempt 3 was interrupted, not failed, so it is re-run as attempt 3 and can still complete. A graceful SIGTERM mid-job now sets the job back to `queued`, decrements `attempts`, and resets progress, guarded by attempt number. A clean shutdown therefore doesn't use up an attempt. Verified: a job stopped mid-run shows `attempts: 0`, and after restart it completes with `attempts: 1`.
2. **Heartbeat errors (`src/worker.ts`).** The heartbeat write is wrapped in try/catch and logged, so a busy or failed write no longer crashes the worker.
3. **Form validation (`ui/index.html`).** The `steps` and `failAttempts` fields are now text inputs with `inputmode="numeric"`, so the browser passes through text like `abc`. The form always sends all three fields: plain numbers go as numbers, blank goes as `null`, and anything else goes as the raw text. The API then rejects it and `form-error` names the field. Verified: `steps: "abc"` returns 400 with `steps`.
4. **Content-Type (`src/server.ts`).** The media type is now parsed and must equal `application/json` exactly. Verified: `application/json-patch+json` returns 400, and `application/json; charset=utf-8` is accepted.
5. **HEAD on the list route (`src/server.ts`).** `HEAD /api/jobs` now uses the same `isGet` check as the other GET routes. Verified: it returns 200.

Also verified: a job with `failAttempts: 3` ends `failed` with `attempts: 3`.