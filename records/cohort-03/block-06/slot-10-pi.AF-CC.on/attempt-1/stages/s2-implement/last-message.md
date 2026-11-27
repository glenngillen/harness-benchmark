Implemented the SQLite-backed job API, validation and idempotency, worker retries and crash recovery, and polling browser UI.

`npm run build` passes. The smoke and contract checks could not run because their runner failed to bind to loopback with `listen EPERM` in this environment.