Implemented the SQLite-backed job API, retrying worker, health heartbeat, durable idempotency, validation, and polling browser UI.

`npm run build` passes, and the worker starts and handles `SIGTERM`. The smoke and contract checks could not run because this environment rejects local server binds with `listen EPERM`.