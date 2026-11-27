Implemented the SQLite-backed job API, worker with retries and crash recovery, heartbeat health check, and polling browser UI.

`npm run build` passes, and the worker starts and shuts down on `SIGTERM`. The contract and smoke checks, and direct server startup, were blocked because this environment rejects local network binds with `listen EPERM`.