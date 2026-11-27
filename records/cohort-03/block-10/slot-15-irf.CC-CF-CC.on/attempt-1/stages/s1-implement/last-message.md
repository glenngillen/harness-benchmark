Implemented the HTTP API, durable SQLite job state and idempotency, worker retries and heartbeat, and polling browser UI. `npm run build` and `git diff --check` pass.

The smoke check could not run because this environment rejects localhost listeners with `EPERM`; I couldn’t verify startup through the check runner.