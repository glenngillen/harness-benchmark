Implemented the SQLite backed job API, worker with retries and restart recovery, idempotent submissions, and a browser page that refreshes job status and progress.

`npm run build` passed, and the worker started successfully. The smoke check and server startup could not bind to a port in this environment (`listen EPERM`), so I couldn’t verify the HTTP behavior here.