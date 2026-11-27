Implemented the SQLite-backed job tracker, HTTP API, retrying worker, and polling browser UI.

`npm run build` passes. The worker starts and shuts down cleanly in a direct check. The smoke and contract checks could not run because this environment blocks loopback listeners with `EPERM`.