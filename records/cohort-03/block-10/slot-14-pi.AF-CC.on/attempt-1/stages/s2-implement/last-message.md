Implemented the SQLite-backed job API and worker, including validation, durable idempotency, retries, crash recovery, health checks, and the polling browser UI.

`npm run build` passes, and the worker exited with code 0 on SIGTERM. The smoke and contract checks, and the server start attempt, were blocked because this environment rejects loopback listeners with `EPERM`.