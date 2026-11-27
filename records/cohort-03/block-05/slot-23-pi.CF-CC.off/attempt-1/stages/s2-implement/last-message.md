Implemented the SQLite-backed job API, worker, validation and idempotency handling, retry recovery, health heartbeat, and polling browser UI.

`npm run build` passes. Both smoke and contract checks were blocked because the sandbox rejects local network binds with `listen EPERM`; I also verified job creation and completion directly against SQLite.