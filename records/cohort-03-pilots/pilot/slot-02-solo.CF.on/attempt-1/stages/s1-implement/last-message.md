Implemented the SQLite-backed API, separate worker, validation, durable idempotency, retries, restart recovery, and live browser UI.

Build passes. Direct API-handler and worker tests pass, including SIGKILL recovery. Supplied smoke and contract checks were blocked by the environment’s TCP restriction (`listen EPERM`).