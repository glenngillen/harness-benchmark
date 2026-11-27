Implemented the SQLite-backed job API, separate worker with progress, retries and restart recovery, and polling browser UI.

`npm run build` passes. The smoke and contract checks could not run because the sandbox blocked their local listener with `listen EPERM`.