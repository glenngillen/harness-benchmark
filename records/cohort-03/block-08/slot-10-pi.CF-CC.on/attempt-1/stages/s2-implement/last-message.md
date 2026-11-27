Implemented the SQLite-backed job API, worker, validation, idempotency, retries, recovery, and polling browser UI.

`npm run build` passes. The smoke and contract checks could not run because this environment rejects loopback listeners with `EPERM`; the worker did start, but I couldn’t verify the server over HTTP here.