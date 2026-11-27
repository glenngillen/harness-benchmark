Implemented the SQLite-backed API, separate worker, durable retries and recovery, idempotency, validation, and live-updating browser UI.

Build passes. Direct API and worker checks pass, including crash recovery. Standard smoke and contract runners were blocked by the environment’s TCP socket restriction (`EPERM`).