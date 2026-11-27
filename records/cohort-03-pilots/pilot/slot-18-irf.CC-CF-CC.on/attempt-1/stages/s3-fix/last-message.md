Addressed all four findings: fixed the UI script and disabled native form validation, made interrupted third failures terminal during recovery, and captured the new job response before the worker can claim it.

`npm run build`, the UI script syntax check, and a recovery check passed. I couldn’t verify HTTP startup here because the environment rejects local socket binding with `EPERM`.