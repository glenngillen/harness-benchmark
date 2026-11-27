Implemented the SQLite-backed job API, separate worker with progress, retries and restart recovery, and polling browser UI. `npm run build` passes, and the worker starts successfully.

The smoke and contract checks could not run: this environment blocks local socket binding with `listen EPERM`, including when starting the HTTP server.