Implemented the SQLite-backed API, separate worker with retries and crash recovery, and live-updating browser UI.

Build and direct handler/worker tests passed. Smoke and contract checks were blocked by the environment’s TCP listener restriction (`EPERM`).