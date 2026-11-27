Implemented the SQLite-backed job API, worker with retries and heartbeat, and browser page with live progress updates. `npm run build` passes, and the worker starts and shuts down cleanly.

I couldn’t verify the HTTP server or run the checks: this environment rejects local network binds with `listen EPERM`, including on `127.0.0.1`.