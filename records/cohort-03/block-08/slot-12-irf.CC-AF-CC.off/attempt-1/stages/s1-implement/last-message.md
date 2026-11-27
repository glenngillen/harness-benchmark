Implemented the SQLite-backed job API, persistent worker with retries and recovery, and browser form with automatic status polling.

`npm run build` passes, and the worker starts and shuts down on `SIGTERM`. The smoke and contract checks could not run because their runner was blocked from opening a loopback listener (`listen EPERM`).