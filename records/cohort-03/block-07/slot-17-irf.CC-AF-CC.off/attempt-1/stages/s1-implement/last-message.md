Implemented the SQLite-backed job API, worker with retries and restart recovery, and polling browser UI.

`npm run build` succeeds, and the worker starts and shuts down on `SIGTERM`. The smoke and contract checks could not run because the sandbox returned `listen EPERM` when they tried to bind to `127.0.0.1`.