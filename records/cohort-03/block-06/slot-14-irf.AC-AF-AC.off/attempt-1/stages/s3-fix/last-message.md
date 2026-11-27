All three findings were correct, and all three are fixed. The build passes, `check:smoke` is 2/2, and `check:contract` is 5/5. The crash test on attempt 3 completed the job.

**What changed**

1. **`attempts` is monotonic (`src/worker.ts`, `src/db.ts`, `src/jobs.ts`).** Interrupted attempts (crash or graceful stop) no longer decrement `attempts`. They increment a new `interrupted_attempts` column. The retry logic uses the logical attempt number `attempts - interrupted_attempts`, so an interrupted attempt is rerun under the same number and does not use up the 3-attempt budget. A job interrupted during attempt 3 is therefore not failed. In the test it finished as `completed`, with `attempts=4` because it counts all started attempts.
2. **Blank optional fields are omitted (`ui/index.html`).** A blank Steps or Fail attempts field is left out of the body so the API applies its default. Non-numeric text is still sent as typed, so the API's validation still shows the error.
3. **Claim and failure are atomic (`src/worker.ts`).** `claimNext()` selects the oldest due job, then either starts the attempt or records a simulated failure (requeue with delay, or mark `failed`) in one `BEGIN IMMEDIATE` transaction. The recovery and interruption writes also run in transactions. A crash can no longer leave a job half-updated.

**Trade-off to be aware of:** a job that was interrupted and then completes shows `attempts` higher than 2 or 3. That follows the spec's definition ("attempts started so far"). The `failed` case still shows `attempts: 3` when there were no interruptions.