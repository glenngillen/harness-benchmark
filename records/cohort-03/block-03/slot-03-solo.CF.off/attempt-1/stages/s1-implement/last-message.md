Implemented the SQLite-backed API, separate worker, durable idempotency, retries, restart recovery, heartbeat, and live-updating browser UI.

Build and direct API/worker verification passed, including SIGKILL recovery. Supplied smoke and contract checks were blocked by the environment’s local socket restriction (`listen EPERM`).