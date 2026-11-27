Implemented the SQLite-backed job API and worker, including validation, idempotency, retries, restart recovery, health reporting, and the polling browser UI.

`npm run build` passes. A worker and retry integration check completed successfully. The smoke and contract suites could not run because this environment blocks local port binding (`listen EPERM`), so I couldn’t verify the HTTP server here.