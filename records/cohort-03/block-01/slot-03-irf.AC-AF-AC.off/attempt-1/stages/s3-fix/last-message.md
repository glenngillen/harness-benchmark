The review finding was correct, and I've fixed it. The application builds, and both check suites still pass (smoke 2/2, contract 5/5).

**What changed (all in `src/worker.ts`)**
- **Crash recovery** (`recoverInterruptedJobs`): a job left `running` is requeued with `attempts` decremented. The dead attempt is treated as never finished, so the re-run reuses its attempt number.
- **Graceful stop** (new `requeueInterrupted`): a SIGTERM during a step or a simulated failure undoes the counted attempt the same way. Simulated failures that finish normally still keep their count via `requeueForRetry`.
- **Guard in `claimNext`**: a queued job that has already used `MAX_ATTEMPTS` is failed instead of starting a fourth attempt. This should be unreachable now, but it's a cheap backstop.

**Verification**
I seeded jobs into the states the reviewer described, then started the worker and checked the outcome:
- `failAttempts: 3`, interrupted during attempt 3: `failed`, `attempts: 3`.
- `failAttempts: 5`, interrupted during attempt 3: `failed`, `attempts: 3`.
- `failAttempts: 0`, interrupted during attempt 3: `completed`, `attempts: 3`.
- `failAttempts: 2`, interrupted during attempt 1: `completed` on attempt 3.
- A real SIGTERM mid-job: the job returns to `queued` with `attempts: 0`, then completes with `attempts: 1`.
- Across all jobs in these runs, the maximum `attempts` was 3.

One note on the test process: my first seeding attempt had a bug in the helper's argument order, so it changed nothing. I caught that from the output and reran with the fix. The results above come from the corrected run.

I haven't committed anything.