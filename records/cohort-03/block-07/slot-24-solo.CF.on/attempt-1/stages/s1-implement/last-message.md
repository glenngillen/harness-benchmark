Implemented the SQLite-backed API, separate worker, validation, durable idempotency, retries, crash recovery, heartbeats, and polling browser UI.

Build and direct worker tests passed. Smoke and contract checks were blocked by the environment’s local port restriction (`listen EPERM`), so HTTP behavior remains unverified. Only `src/` and `ui/` changed.