Implemented the SQLite-backed job API, separate polling worker with retries and crash recovery, heartbeat health check, and browser submission page.

`npm run build` passes. The smoke and contract checks could not run because the sandbox rejects binding to `127.0.0.1` with `listen EPERM`. `git diff --check` is clean.