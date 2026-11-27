Implemented the SQLite-backed HTTP API, separate worker with retries and crash recovery, and polling browser UI.

`npm run build` passes, and the worker starts and shuts down cleanly. I couldn’t verify the server startup or run the smoke and contract checks because this environment denies local network listeners with `listen EPERM`.