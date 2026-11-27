# Review findings

1. [major] src/jobs.ts:136 — Restart recovery marks interrupted successful attempts as transient failures.
   Evidence: `recoverInterruptedJobs` unconditionally fails running jobs with `attempts >= 3`. A job with `failAttempts: 2` that is killed during its third, successful attempt therefore becomes permanently failed on restart without being processed again. An in-memory reproduction confirmed this transition. Graceful shutdown instead requeues the same attempt, allowing a fourth attempt.
   Fix: Distinguish interrupted processing from simulated transient failures and implement consistent recovery for SIGTERM and SIGKILL. Restart interrupted work without fabricating a transient failure merely because the attempt counter reached three.

2. [major] src/jobs.ts:110 — SQLite text round-tripping corrupts valid inputs containing null characters.
   Evidence: On the supplied Node version, inserting `input: "a\u0000b"` through `insertJob` returns a job with `input: "a"`. The worker consequently produces `"A"` instead of `"A\u0000B"`. Idempotency comparison also uses the truncated value, so replaying the original payload incorrectly conflicts. The validation rules permit this input and require exact preservation.
   Fix: Store input and output using a lossless representation, such as JSON-encoded strings, and decode them when reading rows. Ensure processing and idempotency comparison use the fully restored strings.