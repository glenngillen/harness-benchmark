Implemented the SQLite-backed job API, retrying worker, heartbeat health check, idempotency handling, and polling browser UI.

`npm run build` passes, and the worker starts and shuts down on `SIGTERM`. The smoke check could not run because the sandbox denied binding to localhost (`listen EPERM`); the contract check was not run for the same reason.