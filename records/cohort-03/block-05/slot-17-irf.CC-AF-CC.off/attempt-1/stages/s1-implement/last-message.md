Implemented the SQLite-backed job API, durable worker with retries and heartbeat, idempotent submissions, and a polling browser UI.

`npm run build` passes, and the worker starts and shuts down cleanly. The smoke and contract checks could not run because this environment rejects the checks’ localhost socket binding with `listen EPERM`.