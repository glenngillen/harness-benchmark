Implemented the HTTP API, durable SQLite job and idempotency storage, retrying worker process, and polling browser UI.

`npm run build` passes, and the worker started and shut down on `SIGTERM`. The smoke and contract checks could not run because the check runner’s localhost port bind failed with `EPERM`. `git diff --check` passes.