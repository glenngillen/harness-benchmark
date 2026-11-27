Implemented the SQLite-backed HTTP API, asynchronous worker with retries and restart recovery, and polling browser UI.

`npm run build` passes. The worker starts and shuts down cleanly in a local database check. The smoke and contract checks could not run because this environment rejects localhost binding with `EPERM`.