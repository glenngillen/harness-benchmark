Implemented the SQLite-backed job API, worker processing and retries, persistent idempotency, health heartbeat, and polling browser UI.

`npm run build` passes, and the worker starts and shuts down on `SIGTERM`. Both provided check runners stop before testing because this environment rejects binding to `127.0.0.1` with `listen EPERM`.