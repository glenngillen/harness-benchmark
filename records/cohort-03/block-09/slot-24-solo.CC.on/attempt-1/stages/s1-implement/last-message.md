Implemented the job tracker with a SQLite-backed HTTP API, worker process, durable retries and idempotency, health heartbeats, and a browser UI that polls for updates.

`npm run build` passed, and the worker started and shut down on `SIGTERM`. The smoke and contract checks could not run because this environment returned `listen EPERM` for loopback networking. `git diff --check` passed.