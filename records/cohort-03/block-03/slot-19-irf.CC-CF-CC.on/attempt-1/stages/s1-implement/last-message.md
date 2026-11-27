Implemented the SQLite-backed API and worker, persistent idempotency and retry state, health heartbeat, and polling browser UI.

`npm run build` passes. The smoke check and server startup could not run because this environment blocks local network binding (`listen EPERM`); the contract check was not run.