Implemented the SQLite-backed job API, worker with retries and crash recovery, and a browser UI that polls for updates. `npm run build` passes, and a direct worker run completed a job with the expected output and progress.

The HTTP smoke check could not run because this sandbox blocks local port binding (`listen EPERM`). `git diff --check` passes.