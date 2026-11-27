Both review findings were correct, and both are fixed. The build is clean, and both check suites pass (smoke 2/2, contract 5/5).

**Finding 1: lossless text (fixed).** `jobs.ts` now stores `input`, `result_output`, and the idempotency payload `input` as JSON-encoded strings, and decodes them on read. The worker decodes the input before uppercasing and encodes the output. I confirmed that `a\u0000b\ud800x` now round-trips exactly through the input and the output, and that replaying it with its key returns 200.

**Finding 2: restart vs. retry limit (fixed).** Recovery moved into the worker and is per job:
- An interrupted attempt that was destined to fail (`attempts <= failAttempts`) counts as that simulated failure. At attempt 3 it becomes `failed` with `"transient failure"`. Earlier attempts are requeued with the normal retry delay.
- Any other interrupted attempt is requeued immediately, as before.

I reproduced the reviewer's case: a job with `failAttempts: 3` left running at attempt 3 now ends `failed` with `attempts: 3`. I reproduced it by writing the post-SIGKILL state directly to the database, because the 100 ms window is too narrow to hit reliably with a real kill.

**Notes**
- A crash-interrupted attempt that was not destined to fail is still requeued without a cap. This is deliberate: the 3-attempt limit applies to simulated transient failures, not to crashes. For example, a `failAttempts: 0` job interrupted at attempt 3 still completes.
- The text encoding changes the stored format. Existing databases from earlier builds are not migrated. The checks and my tests all use fresh databases.