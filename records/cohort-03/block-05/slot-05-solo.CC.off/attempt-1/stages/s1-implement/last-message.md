Implemented the SQLite-backed job API, retrying worker, and browser UI with live status updates. `npm run build` passes, and a worker check confirmed retry completion and terminal failure behavior.

The smoke and contract checks, and server startup, are blocked because this environment rejects localhost binding with `listen EPERM`. The worker starts successfully.