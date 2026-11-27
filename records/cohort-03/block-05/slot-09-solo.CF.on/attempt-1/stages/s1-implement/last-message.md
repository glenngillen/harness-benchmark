Implemented the SQLite-backed API, separate worker with retries and crash recovery, durable idempotency, validation, and live-updating browser UI.

Build passes. Provided checks passed through direct HTTP-handler testing, alongside worker recovery tests. Normal check commands were blocked by the environment’s socket restriction (`listen EPERM`).