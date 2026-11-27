Implemented the SQLite backed job API and worker, including validation, idempotency, retries, recovery, and the polling browser page.

`npm run build` passed, and the worker started with a temporary database. The smoke and contract checks could not run because their test server hit `listen EPERM` when binding to `127.0.0.1`.