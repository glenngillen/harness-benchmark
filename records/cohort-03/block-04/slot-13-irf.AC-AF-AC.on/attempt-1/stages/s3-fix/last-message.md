All four review findings were correct, and I fixed each one. The build passes, smoke is 2/2, and contract is 5/5.

1. **Attempts past the limit after restart (major), fixed.** Recovery now undoes the increment for interrupted attempts with `attempts = MAX(attempts - 1, 0)`. The re-run reuses the interrupted attempt number. Test: `failAttempts: 2`, killed with `kill -9` during attempt 3. After restart it completed with `attempts: 3`.
2. **Stale heartbeat after shutdown (minor), fixed.** The worker deletes its heartbeat row before closing the database. `/health` reported `worker: "down"` immediately after SIGTERM.
3. **Graceful stop mid-job (minor), fixed.** On SIGTERM mid-step the job is requeued at once with `next_run_at = 0` and the attempt increment rolled back. After restart it ran as attempt 1 and completed, without relying on crash recovery.
4. **UI nodes detached every second (minor), fixed.** Job items are now kept in a map by id and updated in place. New jobs are inserted at the top, and only removed jobs are dropped. I syntax-checked the inline script but did not exercise it in a browser.

I changed only `src/worker.ts` and `ui/index.html`. Nothing is committed.