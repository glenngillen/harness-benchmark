Implemented the SQLite-backed job API, worker processing with retries and restart recovery, and a browser UI with automatic status updates.

`npm run build` passes. The smoke and contract checks could not run because the environment blocks binding to `127.0.0.1` (`listen EPERM`).