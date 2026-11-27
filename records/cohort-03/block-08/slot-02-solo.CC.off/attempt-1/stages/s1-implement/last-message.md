Implemented the SQLite-backed job API and worker, including durable state, idempotency, progress, retries, and heartbeat reporting. Added the browser form and live job list.

`npm run build` passes, and the worker starts and shuts down cleanly. The smoke and contract checks could not run because the environment rejected their localhost listener with `EPERM`.