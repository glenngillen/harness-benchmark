Implemented the SQLite-backed API, separate worker with retries and restart recovery, and live-updating browser UI.

Build passed. All five contract checks passed through a socket-free harness, plus retry and SIGKILL recovery tests. Standard smoke/contract runners were blocked by sandbox port-binding restrictions (`EPERM`).