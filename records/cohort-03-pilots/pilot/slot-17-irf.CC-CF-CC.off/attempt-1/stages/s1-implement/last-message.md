Implemented the SQLite-backed job API and worker, including idempotency, retries, crash recovery, heartbeat health checks, and the polling browser UI.

`npm run build` passes, and the worker started and shut down on `SIGTERM`. The smoke and contract checks could not run because this environment rejects localhost binding with `listen EPERM`.