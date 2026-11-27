All three findings were correct, and I fixed each one in `src/worker.ts`. The build passes, `check:smoke` passes 2/2, and `check:contract` passes 5/5.

- **Finding 1 (attempt count after a crash):** Recovery now decrements `attempts` for rows left `running`, so the re-run reuses the interrupted attempt's number. A job with `failAttempts: 2` killed mid-run completed with `attempts: 3`, which is correct. I did not separately rerun the `failAttempts: 3` case.
- **Finding 2 (write error strands a job):** If `runAttempt` throws, the catch block now puts the job back to `queued` with `attempts` decremented and a 250 ms `run_after`. The update only matches rows still `running`. If that write also fails, it is logged.
- **Finding 3 (heartbeat crash):** The heartbeat write is wrapped in try/catch, so a failed write is logged and the worker keeps running.

I did not address anything else. The reviewer's other findings were not in scope for this pass.