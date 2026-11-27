Implemented the SQLite-backed HTTP API, separate worker with retries and crash recovery, heartbeat health check, and browser submission and progress UI.

`npm run build` passes, and the worker starts and shuts down on `SIGTERM`. The smoke and contract checks, and the server startup, were blocked because this environment rejects local socket binding with `EPERM`.