Implemented the SQLite-backed API, separate worker, and live browser UI, including validation, idempotency, retries, heartbeats, and restart recovery.

Build passes. Direct worker tests passed, including SIGKILL recovery. Smoke and contract checks were blocked by the environment’s local socket restriction (`listen EPERM`).