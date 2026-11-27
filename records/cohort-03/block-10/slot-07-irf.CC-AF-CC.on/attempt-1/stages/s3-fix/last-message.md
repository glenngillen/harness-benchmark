Addressed all three findings: startup recovery and graceful SIGTERM now requeue interrupted jobs and roll back the interrupted attempt; empty numeric fields are omitted so API defaults apply.

`npm run build` passes. I also confirmed the worker recovers a job interrupted on attempt 3 and completes it. Server and HTTP checks remain blocked by this environment’s `listen EPERM` socket restriction.