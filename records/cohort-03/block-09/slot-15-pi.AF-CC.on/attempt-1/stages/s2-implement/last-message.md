Implemented the SQLite-backed job API, worker with progress and retries, and polling browser UI.

`npm run build` and `git diff --check` pass. I verified worker completion and retry outcomes in a temporary database. I couldn’t run the HTTP checks here: the sandbox rejects local port binding with `listen EPERM`, so the server and check runner could not start. No worker process was left running.