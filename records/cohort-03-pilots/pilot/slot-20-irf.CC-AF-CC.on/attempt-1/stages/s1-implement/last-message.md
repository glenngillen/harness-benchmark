Implemented the SQLite-backed HTTP API, retrying worker, and browser UI with live polling. The worker starts and shuts down cleanly, and `npm run build` passes.

Both provided checks were blocked because the environment denied local network binds (`listen EPERM` on 127.0.0.1).