Implemented the SQLite-backed API, separate worker, retries, crash recovery, durable idempotency, and live-updating browser UI.

Build and direct API/worker checks passed. Supplied smoke and contract runners were blocked by the environment’s socket-binding restriction (`EPERM`).

Only `src/` and `ui/` changed.