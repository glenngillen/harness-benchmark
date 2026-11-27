Implemented the SQLite-backed job API, worker with retries and restart recovery, and browser UI with live polling.

`npm run build` and `git diff --check` pass. The worker started and shut down cleanly. The smoke and contract checks couldn’t run because the environment denied localhost binding with `listen EPERM`.