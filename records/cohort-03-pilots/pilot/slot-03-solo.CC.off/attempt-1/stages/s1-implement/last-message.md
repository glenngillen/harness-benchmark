Implemented the SQLite-backed job API and worker, including durable jobs, idempotency, retries, crash recovery, worker heartbeats, and the polling browser UI.

`npm run build` passes, and the worker starts and shuts down cleanly. The smoke and contract checks could not run because this sandbox rejects local socket binding (`listen EPERM`), including when starting the server.