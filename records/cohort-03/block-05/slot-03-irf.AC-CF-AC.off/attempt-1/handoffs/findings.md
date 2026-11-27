# Review findings

1. [major] src/worker.ts:41 — Restart recovery erases processing attempts that already started.
   Evidence: Both `recoverAbandonedJobs()` and `rollBack()` (line 67) decrement `attempts`. Executing each against an in-memory running job with `attempts = 1` and four completed steps produced a queued job with `attempts = 0`. After restarting and completing, it would report only one attempt despite having started twice. This contradicts the required definition and lets repeated interruptions bypass attempt accounting.
   Fix: Preserve the count of started attempts during recovery and graceful shutdown. Increment it when another attempt starts, and enforce the retry limit consistently across restarts.

2. [minor] src/server.ts:160 — The body-size restriction rejects otherwise valid submissions.
   Evidence: Calling the submission handler with `{"input":"a"}` returns 201, but prefixing the same JSON with 65,536 spaces returns `400 invalid_request` (“body is too large”). Both bodies satisfy the specified validation rules; the task limits input string length, not serialized request size.
   Fix: Remove the additional 64 KiB rejection or parse the request in a way that permits valid JSON whitespace while enforcing the specified field constraints.