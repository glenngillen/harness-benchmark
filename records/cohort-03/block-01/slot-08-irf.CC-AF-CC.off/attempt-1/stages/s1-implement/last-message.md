Implemented the SQLite-backed job API, separate worker with progress and retry handling, durable idempotency, heartbeat health check, and polling browser UI.

`npm run build` passes, and the worker starts and shuts down. The smoke and contract checks could not run because this environment blocks binding to `127.0.0.1` (`listen EPERM`).