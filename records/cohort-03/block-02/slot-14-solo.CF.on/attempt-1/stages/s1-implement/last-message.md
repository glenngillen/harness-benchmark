Implemented the SQLite-backed API, separate worker, validation, durable idempotency, retries, crash recovery, heartbeats, and polling browser UI.

Build passes. Direct-handler contract tests and worker recovery tests pass. The supplied smoke and contract runners were blocked by this environment’s TCP-listening restriction (`EPERM`).