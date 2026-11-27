All five findings are addressed. The build passes, and the smoke (2/2) and contract (5/5) suites still pass. Nothing is committed.

1. **Idempotency race (fixed, with a caveat).** A failed insert with a UNIQUE violation now re-reads the key and returns the 200 replay or 409 conflict, not a 500. In one server process the lookup and insert run with no `await` between them, so the race can't actually happen there. The guard is still worth having. The concurrent test gave one 201 and five 200s.
2. **Attempts above 3 after a crash (fixed).** I chose this rule: a crashed attempt keeps its number. The job is requeued with a `resume_attempt` flag, and the next claim re-runs that same attempt without incrementing `attempts`. So `attempts` never exceeds 3. A job killed during attempt 3 with `failAttempts: 2` completes on attempt 3 with `attempts: 3`. I tested this: the job was killed with SIGKILL mid-run and finished with `attempts: 3`.
3. **Graceful stop decrementing `attempts` (fixed).** `revertToQueued` no longer touches `attempts`. It sets the same resume flag as a crash.
4. **Malformed percent-encoding returned 500 (fixed).** The decode is wrapped, and `/api/jobs/%E0%A4%A` now returns 404 `not_found`.
5. **Form number conversion (fixed).** Only plain decimal text such as `3` or `-2.5` is converted to a number. Everything else, including `0x10`, `1e1`, and empty fields, is sent as text so the API rejects it and names the field in `form-error`. I took the reviewer's suggestion to send empty fields as `""` rather than leaving them out.

I declined none of the findings.