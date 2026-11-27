Implemented the SQLite-backed job API, retrying worker, and polling browser UI.

`npm run build` passes, and the worker starts and shuts down. The smoke and contract checks could not run because this environment denies local socket binding (`listen EPERM`), including the checks’ attempt to reserve a port.