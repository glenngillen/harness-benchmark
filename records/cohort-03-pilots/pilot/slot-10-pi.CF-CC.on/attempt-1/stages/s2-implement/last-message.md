Implemented the SQLite-backed job API, worker, validation and idempotency handling, and browser UI. `npm run build` passes.

The worker started against a fresh nested database and completed a retrying job. The smoke and contract checks could not run because this environment blocks localhost sockets (`listen EPERM`); the server start hit the same restriction.