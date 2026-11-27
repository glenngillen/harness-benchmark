Implemented the SQLite-backed API, durable idempotency, separate worker with retries and crash recovery, and browser UI with live progress.

Build passes. Direct API-handler checks and worker recovery tests pass. The supplied smoke and contract runners were blocked by sandbox TCP restrictions (`EPERM`).

Only files under `src/` and `ui/` changed.