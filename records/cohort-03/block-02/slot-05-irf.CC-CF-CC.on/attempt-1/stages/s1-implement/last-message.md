Implemented the SQLite-backed job API and worker, including validation, idempotency, retries, restart recovery, and worker health reporting. Added the browser form and live-updating job list.

`npm run build` passes, and the worker starts and shuts down cleanly. The smoke and contract checks could not run because the sandbox rejected their local listeners with `listen EPERM`.