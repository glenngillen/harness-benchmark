Addressed all three findings: the form now sends invalid values to the API, the worker refreshes its heartbeat after each step, and unexpected handler errors return JSON 500 responses.

`npm run build` passes. The smoke check still cannot run because the harness denies listening on `127.0.0.1` with `EPERM`, so I couldn’t verify startup through that check.