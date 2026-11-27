Implemented the SQLite-backed job API, separate worker with retries and crash recovery, and browser UI with live status polling.

`npm run build` passes. The worker starts and writes its heartbeat. The smoke and contract checks could not run because this environment rejects local network binds with `listen EPERM`.