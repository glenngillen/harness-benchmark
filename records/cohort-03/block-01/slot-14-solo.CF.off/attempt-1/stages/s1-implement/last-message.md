Implemented the SQLite-backed API, separate worker, retries, crash recovery, persistent idempotency, and polling browser UI.

Build passes. Direct handler checks with a separate worker passed, including validation and SIGKILL recovery. Standard smoke/contract runners were blocked by sandbox localhost binding restrictions (`EPERM`).

Only files under `src/` and `ui/` changed.