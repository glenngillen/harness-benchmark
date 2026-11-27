Implemented the SQLite-backed job API and worker, including validation, idempotency, retries, recovery, and heartbeat health reporting. Added the polling browser form.

`npm run build` passes. The smoke and contract checks could not start: their runner hit `listen EPERM` while trying to allocate a local port.