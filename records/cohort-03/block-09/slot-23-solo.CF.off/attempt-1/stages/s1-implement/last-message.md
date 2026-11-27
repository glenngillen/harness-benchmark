Implemented the SQLite-backed API, separate worker with retries and crash recovery, and live-updating browser UI.

Build passed. Direct worker tests passed for progress, retries, failures, heartbeats, recovery, and shutdown.

Smoke and contract checks were blocked by the environment’s TCP binding restriction (`listen EPERM`).