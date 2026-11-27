Implemented the SQLite-backed job API, separate worker process, durable retries and restart recovery, heartbeat health check, and polling browser UI.

`npm run build` passes, and `start:worker` started and shut down cleanly. The smoke checks could not run because the environment denied their localhost bind (`listen EPERM`), before they reached the app.