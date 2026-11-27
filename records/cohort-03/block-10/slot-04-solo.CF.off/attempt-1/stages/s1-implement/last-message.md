Implemented the SQLite-backed API, separate worker with retries and restart recovery, and browser UI with live progress updates.

Build passes. Direct worker checks pass for progress, retries, failures, persistence, and shutdown. Smoke and contract checks were blocked by the environment’s port-binding restriction (`EPERM`).