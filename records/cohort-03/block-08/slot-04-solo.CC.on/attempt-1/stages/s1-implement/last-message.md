Implemented the SQLite-backed job API, retrying worker, heartbeat health check, and live browser UI. `npm run build` passes, and the worker starts.

The smoke and contract checks could not run because this environment rejects local network binding (`listen EPERM`); the server therefore could not be started here for HTTP verification.