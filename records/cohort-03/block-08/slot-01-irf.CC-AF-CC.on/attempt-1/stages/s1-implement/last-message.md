Implemented the job tracker with durable SQLite job and idempotency state, a separate retrying worker with progress and heartbeat updates, the HTTP API, and a polling browser UI.

`npm run build` passes. The smoke check could not run because its test runner failed to bind a local port (`EPERM`).