Addressed all five findings: disabled browser-side validation so API errors reach the alert, made interrupted attempts resumable without consuming a retry, removed the heartbeat on shutdown, and added worker error recovery.

`npm run build` passes. The provided checks could not start their HTTP listener because the environment blocks binding to `127.0.0.1` (`listen EPERM`).