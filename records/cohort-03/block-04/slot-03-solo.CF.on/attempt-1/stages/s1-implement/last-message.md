Implemented the SQLite-backed API, durable idempotency, separate worker with retries and crash recovery, and live-updating browser UI.

Build and direct API/worker checks passed. The provided smoke and contract checks were blocked by the sandbox’s socket restriction (`listen EPERM`).