Implemented the HTTP API, SQLite-backed job and idempotency state, retrying worker, and polling browser UI.

`npm run build` passes, and the worker starts. The smoke and contract checks, and the server startup attempt, were blocked because this environment rejects TCP binding with `listen EPERM`.