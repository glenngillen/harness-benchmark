Implemented the job tracker with durable SQLite state, idempotent submissions, retrying worker processing, health reporting, and a polling browser UI.

`npm run build` and `git diff --check` pass. The smoke and contract checks could not run: the harness denied their attempt to listen on `127.0.0.1` with `EPERM`.