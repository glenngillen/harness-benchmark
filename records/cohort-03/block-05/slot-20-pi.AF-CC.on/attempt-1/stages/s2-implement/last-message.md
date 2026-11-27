Implemented the SQLite-backed job API, worker, retry and recovery handling, and browser UI.

`npm run build` passes, and the worker started and exited cleanly on `SIGTERM`. The smoke and contract checks could not run: this environment rejects localhost binds with `listen EPERM`, including when starting the server directly. The server therefore could not be runtime-verified here.