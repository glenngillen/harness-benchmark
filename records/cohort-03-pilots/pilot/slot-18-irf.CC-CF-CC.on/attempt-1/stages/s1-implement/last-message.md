Implemented the SQLite-backed job API and worker, including validation, idempotency, retries, heartbeat health checks, and restart recovery. Added the browser form and live job list.

`npm run build` passed, and the worker started and shut down cleanly. The smoke and contract checks could not run because this environment rejects local socket binding with `EPERM`.