Implemented the SQLite-backed API, separate worker, retries, idempotency, restart recovery, and live browser UI.

Build passed. Direct tests passed for validation, processing, retries, persistence, and SIGKILL recovery.

Provided smoke/contract checks were blocked by the environment’s TCP listener restriction (`EPERM`).