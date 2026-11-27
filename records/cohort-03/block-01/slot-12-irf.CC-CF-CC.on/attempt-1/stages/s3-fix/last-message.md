Addressed all four findings:

- Interrupted jobs replay the same attempt, so a crash during a successful third attempt won’t mark the job failed.
- Request bodies are decoded after concatenating UTF-8 chunks.
- Malformed URLs return JSON 404 responses, and unexpected handler errors are caught.
- The form lets invalid values reach API validation and display field errors.

The build succeeds and the worker starts and shuts down. Server startup and the check suites are blocked here because the environment denies socket binding with `listen EPERM`.