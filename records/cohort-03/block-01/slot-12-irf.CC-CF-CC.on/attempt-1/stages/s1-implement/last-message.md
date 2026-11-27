Implemented the SQLite-backed job API, worker with progress and retries, and browser UI with automatic polling.

`npm run build` succeeds, and the worker starts and shuts down. The smoke and contract checks could not run because this environment blocks binding to `127.0.0.1` (`listen EPERM`).