Addressed all three findings:

- Interrupted attempts resume without incrementing the attempt count; an interrupted third simulated failure becomes `failed`.
- Request URL parsing failures return JSON `404` responses, and the handler catches unexpected exceptions.
- Job creation uses `INSERT … RETURNING` so its `201` response reflects the queued row atomically.

The build and diff check pass. I also verified recovery of a running job at attempt 3 with `failAttempts: 3`; it became failed with `attempts: 3`. Server and check-runner startup remain unverified because this environment blocks TCP listeners with `EPERM`.