Implemented the SQLite-backed HTTP API, retrying worker, and polling browser UI.

`npm run build` passes, and the worker starts. The smoke and contract checks could not run because this environment rejects local port binding (`listen EPERM`); the server’s startup could not be verified here for the same reason.