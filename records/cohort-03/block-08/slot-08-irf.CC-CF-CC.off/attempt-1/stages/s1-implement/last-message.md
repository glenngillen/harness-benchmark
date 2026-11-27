Implemented the SQLite-backed job API, worker, and browser UI. The worker processed a queued job successfully, and `npm run build` passes.

The smoke and contract checks, plus server startup, could not run because this environment blocks socket binding (`listen EPERM`). Worker startup succeeded.