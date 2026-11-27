Implemented the SQLite-backed job tracker: the HTTP API, separate worker with retries and restart recovery, idempotent submissions, and a polling browser UI.

`npm run build` passes, and the worker starts. The smoke and contract checks, and a server startup attempt, were blocked because this environment denies listening on local ports (`EPERM`).