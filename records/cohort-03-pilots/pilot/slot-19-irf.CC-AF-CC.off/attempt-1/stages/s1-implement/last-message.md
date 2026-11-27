Implemented the SQLite-backed job API, worker with progress and retries, durable idempotency, health heartbeat, and polling browser UI.

`npm run build` and `git diff --check` pass. The smoke and contract checks could not run because the environment denied binding to `127.0.0.1` (`listen EPERM`).