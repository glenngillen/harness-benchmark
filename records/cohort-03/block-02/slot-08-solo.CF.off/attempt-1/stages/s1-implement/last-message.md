Implemented the SQLite-backed API, separate worker, retries, restart recovery, durable idempotency, and live-updating browser UI.

Build passes. Direct-handler checks with a separate worker passed, including validation, retry limits, and SIGKILL recovery. Standard smoke and contract runners were blocked by the environment’s TCP restriction (`listen EPERM`).