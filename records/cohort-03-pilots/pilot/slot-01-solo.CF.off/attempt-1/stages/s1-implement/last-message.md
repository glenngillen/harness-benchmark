Implemented the SQLite-backed API, separate worker with retries and restart recovery, and browser UI with live progress and validation errors.

Build passes. Direct verification passed for validation, idempotency, processing, retries, heartbeat, and crash recovery.

The provided smoke and contract checks were blocked by the environment’s socket-binding restriction (`EPERM`).