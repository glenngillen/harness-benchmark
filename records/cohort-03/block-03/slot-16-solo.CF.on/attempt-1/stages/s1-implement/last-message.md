Implemented the SQLite-backed API, separate worker with retries and crash recovery, and auto-refreshing browser UI.

Build passes. Direct handler and worker tests passed, including idempotency, validation, and recovery. Smoke and contract checks were blocked by the sandbox’s local-port restriction (`listen EPERM`).