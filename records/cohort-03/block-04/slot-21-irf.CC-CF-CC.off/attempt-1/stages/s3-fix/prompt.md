A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:13 — Restarting the worker can permanently fail a job whose successful attempt was interrupted.
   Evidence: Startup marks every `running` job with `attempts >= 3` as failed. A job with `failAttempts: 2` that is killed partway through attempt 3 therefore becomes `"failed"` on restart, even though that attempt should succeed. The task requires interrupted running jobs to be processed again.
   Fix: Recover interrupted work without declaring a simulated transient failure. Allow the interrupted final attempt to finish, and reserve terminal `"transient failure"` for an actual third failed attempt.

2. [major] src/server.ts:54 — An unknown request path can crash the server instead of returning JSON.
   Evidence: Invoking the request handler with `GET //[` rejects with `Invalid URL`. `new URL()` interprets the leading `//` as an authority, and its exception escapes the async handler. Node’s HTTP server does not handle that rejected promise, so normal unhandled-rejection behavior terminates the process.
   Fix: Parse request paths defensively and catch URL parsing errors, returning the required JSON `404 not_found` for unknown paths.

3. [major] src/server.ts:20 — Request decoding corrupts valid Unicode input when a character spans chunks.
   Evidence: Calling the handler with the UTF-8 bytes for `{"input":"café","steps":1}` split between the two bytes of `é` returned `201` with stored input `"caf��"`. Independently calling `toString()` on each chunk loses incomplete UTF-8 sequences, violating exact input preservation and producing incorrect output.
   Fix: Use streaming UTF-8 decoding, such as `req.setEncoding('utf8')`, or concatenate buffers and decode once after reading the body.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. The runner will not run them for you or send you their output. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
