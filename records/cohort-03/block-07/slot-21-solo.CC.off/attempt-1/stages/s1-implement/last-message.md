Implemented the SQLite-backed job API, retrying worker, and polling browser UI. `npm run build` passes, and the worker starts successfully.

I couldn’t verify the server over HTTP: this environment rejects socket binding with `listen EPERM`, including when running the provided check runner.