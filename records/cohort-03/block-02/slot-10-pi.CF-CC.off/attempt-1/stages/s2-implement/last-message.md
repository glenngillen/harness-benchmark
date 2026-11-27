Implemented the SQLite-backed job API, separate worker with retries and restart recovery, validation and idempotency, and the polling browser UI. `npm run build` and `git diff --check` pass; the worker starts with a nested database path.

The smoke and contract checks could not run because this environment rejects localhost binds with `listen EPERM`.