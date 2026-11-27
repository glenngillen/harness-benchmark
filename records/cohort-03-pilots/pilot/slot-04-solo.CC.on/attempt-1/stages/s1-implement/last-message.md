Implemented the SQLite-backed job API, separate worker with progress, retries and restart recovery, and browser submission page.

`npm run build` passed, and the worker started. I couldn’t verify the server’s HTTP startup because this environment rejects socket binds with `EPERM`.