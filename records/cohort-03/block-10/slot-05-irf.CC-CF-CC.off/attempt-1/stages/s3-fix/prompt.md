A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:11 — Restart recovery can exceed the three-attempt limit and complete a job that should fail.
   Evidence: Recovery requeues every running job, and claiming increments its attempts again. Running the worker against an in-memory restart state with `status="running"`, `attempts=3`, and `failAttempts=3` produced `status="completed"` and `attempts=4`. This state is reachable by killing the worker during the third attempt’s first-step delay.
   Fix: Handle interrupted attempts without bypassing the retry limit. A third attempt subject to transient failure must end as `failed`, with `"transient failure"` and `attempts=3`, including after restart.

2. [major] src/server.ts:52 — Explicit `null` numeric fields are accepted instead of rejected.
   Evidence: Invoking the request handler with `{"input":"a","steps":null}` or `{"input":"a","failAttempts":null}` returned `201` and created jobs using defaults. The `??` expressions treat `null` as omission, although validation requires rejecting wrong types.
   Fix: Apply defaults only when the field is absent, and validate explicitly supplied `null` values. Return `400 invalid_request` naming each offending field without creating a job.

3. [major] src/server.ts:15 — Decoding each request chunk separately corrupts valid Unicode input.
   Evidence: Passing the valid JSON body `{"input":"é"}` in two buffers split between the UTF-8 bytes of `é` returned `201` with `input="��"`. HTTP chunks can split anywhere, so valid submissions can lose their original text and produce incorrect results or idempotency conflicts.
   Fix: Concatenate the buffers before decoding, or use a streaming UTF-8 decoder such as `StringDecoder` or `req.setEncoding('utf8')`.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
