Implemented the SQLite-backed job API, retrying worker, and polling browser UI. `npm run build` passes, and the worker starts.

The smoke and contract checks could not run because the environment rejected binding to `127.0.0.1` with `listen EPERM`.