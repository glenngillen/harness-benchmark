All five findings were correct, and I fixed each one. `npm run build`, `check:smoke` (2/2) and `check:contract` (5/5) pass.

1. **Attempt count on recovery (`src/worker.ts`):** `attempts` is no longer decremented. Interrupted jobs are requeued with `attempts` unchanged, or marked `failed` with `"transient failure"` if they have already used all three attempts. A job that crashes the worker on every attempt now stops at the cap. I checked this with three kills and then a restart, which ended `failed` with `attempts: 3`.
2. **SIGTERM mid-job (`src/worker.ts`):** The in-flight job is requeued before the DB closes. I checked that a job stopped mid-run shows `queued` with `completed: 0`.
3. **Request body (`src/server.ts`):** `readBody` resolves `null` as soon as the body passes 64 KB, and also when the client disconnects before the body ends. A 70 KB upload returns `400`.
4. **URL parsing (`src/server.ts`):** The path comes from the raw request target with the query stripped. Targets starting with `//` return `404 not_found`, so `//api/jobs` and `//` no longer resolve. `/?x=1` and `/api/jobs?x=1` still work.
5. **`PORT` (`src/server.ts`):** Unset or empty uses 3000. Any other value that isn't an integer from 1 to 65535 makes the server exit with an error. I chose to fail on bad values rather than silently fall back to 3000.

Nothing was left running after the tests.