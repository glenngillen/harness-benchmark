Implemented the SQLite-backed API, separate worker, and browser UI with validation, idempotency, progress, retries, heartbeat monitoring, and crash recovery.

Build and direct API/worker checks pass. Supplied smoke and contract checks were blocked by the environment’s socket restriction (`listen EPERM`).