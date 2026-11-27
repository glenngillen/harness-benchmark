Implemented the SQLite-backed job API, retrying worker, and polling browser UI. The worker starts successfully, `npm run build` passes, and `git diff --check` is clean.

The smoke and contract checks could not run because the environment rejected their local `127.0.0.1` bind with `EPERM`.