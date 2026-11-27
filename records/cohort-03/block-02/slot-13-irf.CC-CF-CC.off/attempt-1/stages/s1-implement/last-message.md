Implemented the SQLite-backed job API and worker, including durable retries, idempotency, heartbeat health checks, and a polling browser UI.

`npm run build` and `git diff --check` pass. The worker started and shut down with `SIGTERM`. The smoke and contract checks, and the server launch, were blocked because this environment rejects listening sockets with `EPERM`.