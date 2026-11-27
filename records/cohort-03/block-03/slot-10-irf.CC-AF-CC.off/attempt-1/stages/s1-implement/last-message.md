Implemented the SQLite-backed HTTP API, retrying worker, and polling browser UI. Job state, idempotency keys, and worker heartbeats are stored in the shared database.

`npm run build` passed, and the worker started and shut down cleanly. The smoke and contract checks could not run because the environment rejected binding to `127.0.0.1` with `listen EPERM`.