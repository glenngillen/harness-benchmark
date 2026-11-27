Implemented the SQLite-backed job API and idempotency, a separate worker with progress updates and retries, and a browser page that refreshes job status automatically.

`npm run build` passed. The worker started and shut down on `SIGTERM`. The smoke and contract checks, and the server startup check, were blocked because this environment rejects localhost listeners with `EPERM`.