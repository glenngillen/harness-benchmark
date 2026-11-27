Implemented the SQLite-backed job API, retrying worker, validation and idempotency handling, and polling browser UI.

`npm run build` passes, and the worker starts. The smoke and contract checks could not run because the sandbox blocks binding to `127.0.0.1` (`listen EPERM`).