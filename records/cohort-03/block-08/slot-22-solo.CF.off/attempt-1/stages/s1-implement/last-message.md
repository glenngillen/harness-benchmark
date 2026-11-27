Implemented the SQLite-backed API, separate worker with retries and restart recovery, durable idempotency, and browser form with live progress updates.

Build passed. Direct-handler contract checks and worker recovery tests passed. Standard smoke and contract runners were blocked by sandbox socket permissions (`EPERM`).

Only files under `src/` and `ui/` changed.