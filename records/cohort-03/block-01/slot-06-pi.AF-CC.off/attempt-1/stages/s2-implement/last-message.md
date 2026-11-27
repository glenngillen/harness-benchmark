Implemented the SQLite-backed job tracker: the HTTP API, durable idempotency and job state, retrying worker, heartbeat health check, and polling browser UI.

`npm run build` passes, and the worker starts with a temporary database. The smoke and contract checks—and direct server startup—could not run because this environment blocks network listeners with `listen EPERM`.