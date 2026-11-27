Implemented the SQLite-backed API, separate worker, retries, restart recovery, idempotency, validation, and live-updating browser UI.

Build and direct API/worker tests passed, including SIGKILL recovery. The provided smoke and contract runners were blocked by sandbox port-binding restrictions (`EPERM`).