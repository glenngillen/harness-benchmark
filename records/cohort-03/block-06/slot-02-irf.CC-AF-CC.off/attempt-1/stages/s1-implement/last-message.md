Implemented the SQLite-backed job API, retrying worker, and browser UI with live status polling. `npm run build` passes.

The smoke and contract checks could not run because this environment blocks local server binding (`listen EPERM`). The worker starts successfully; direct server startup is blocked by the same restriction.