Implemented the SQLite-backed job API, worker, validation and idempotency handling, and polling browser UI. `npm run build` passes, and a worker run completed a job with the expected uppercase result.

The smoke and contract checks could not proceed because the environment denied binding to `127.0.0.1` (`listen EPERM`). The worker started and shut down on SIGTERM.