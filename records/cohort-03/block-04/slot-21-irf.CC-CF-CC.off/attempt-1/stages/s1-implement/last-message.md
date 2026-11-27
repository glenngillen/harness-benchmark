Implemented the SQLite-backed job API, separate worker with retries and restart recovery, and polling browser UI.

`npm run build` passes, and the worker starts. The smoke and contract checks could not run because their localhost listener was rejected with `EPERM`.