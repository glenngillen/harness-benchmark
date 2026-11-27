Implemented the SQLite-backed job tracker: HTTP API with validation and durable idempotency, a separate worker with progress, retries, and restart recovery, and a browser page that refreshes job status.

`npm run build` passes. The smoke and contract checks could not run because this environment rejects localhost socket binding with `listen EPERM`.