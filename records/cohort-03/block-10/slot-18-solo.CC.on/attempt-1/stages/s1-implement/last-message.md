Implemented the SQLite-backed job API and worker, including validation, idempotency, retries, restart recovery, and worker health reporting. Added the browser form and live job list.

`npm run build` and `git diff --check` passed. The worker started; server startup and both check suites were blocked because this environment rejects network binds with `EPERM`.