A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/worker.ts:10 — Restart recovery can bypass the three-attempt limit and complete a job that must fail.
   Evidence: Startup requeues every running job, and claiming increments its attempts unconditionally. Testing recovery from `status='running', attempts=3, failAttempts=3` produced `status='completed', attempts=4, result_output='HELLO'`. This state can persist if the worker dies between claiming the third attempt and recording its failure.
   Fix: Enforce the attempt limit during recovery and claiming. An interrupted third attempt that must simulate failure should become `failed` with `"transient failure"` and `attempts=3`, rather than advance to a fourth attempt.

2. [major] src/server.ts:60 — An unknown request path can terminate the server instead of returning JSON.
   Evidence: Invoking the request handler with `GET //%` rejects with `ERR_INVALID_URL`. URL parsing is outside any catch, and the HTTP server does not handle the async callback’s rejected promise, so Node terminates on the unhandled rejection.
   Fix: Safely parse request targets and handle parsing failures with a JSON error response. Ensure unknown paths return `404 not_found` and request-handler exceptions cannot terminate the process.

3. [major] src/server.ts:125 — A newly created job can be returned as running instead of queued.
   Evidence: The INSERT commits before the separate SELECT used to construct the `201` response. The independent worker can claim the job between those statements, causing the creation response to contain `status='running'` and `attempts=1`, contrary to the required queued representation.
   Fix: Capture the inserted row atomically using `INSERT … RETURNING`, or construct the creation response from the initial values instead of rereading mutable state after committing.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
