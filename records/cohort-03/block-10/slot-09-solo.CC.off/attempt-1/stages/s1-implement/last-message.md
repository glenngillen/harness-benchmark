Implemented the SQLite-backed job API, worker with progress and retries, and polling browser UI.

`npm run build` passes, and the worker starts. The smoke check and server startup could not be verified because this environment rejects local network binds with `listen EPERM`; the check runner hits the same restriction.