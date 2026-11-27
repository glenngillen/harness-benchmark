Implemented the SQLite-backed HTTP API and worker, including validation, durable idempotency, retries, recovery after worker restarts, and the polling browser UI.

`npm run build` passes, and the worker starts and shuts down cleanly. The smoke and contract checks could not run: the sandbox blocks localhost listeners with `EPERM`. `git diff --check` passes.