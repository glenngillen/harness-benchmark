A reviewer has examined your implementation. Their findings are below. Address the ones that are correct; you may decline a finding you are confident is wrong, but say why in your summary.

## Findings

# Review findings

1. [major] src/jobs.ts:99 — SQLite string storage does not preserve all valid inputs.
   Evidence: An in-memory round-trip through `insertJob` changes `"a\u0000b"` to `"a"` and `"a\ud800b"` to `"a�b"`. Both inputs pass validation. This violates exact input preservation, produces incorrect uppercase output, and makes identical keyed submissions return an idempotency conflict because the stored input differs.
   Fix: Store input and output using a lossless encoding, such as JSON-encoded strings, and decode them when reading rows and comparing submissions.

2. [major] src/jobs.ts:114 — Restart recovery can exceed the three-attempt limit.
   Evidence: With `failAttempts: 2`, scheduling the first two retries, claiming attempt 3, then invoking either shutdown release or expired-lease recovery causes the next claim to start attempt 4. The worker then completes that fourth attempt. Neither recovery nor claiming enforces the required maximum.
   Fix: Define recovery behavior for an interrupted final attempt and enforce the attempt budget atomically. Recover interrupted processing without allowing a fourth counted attempt, while preserving the requirement that interrupted jobs finish after restart.

3. [minor] src/worker.ts:32 — Simulated failures skip the first step’s required processing time.
   Evidence: The failure branch immediately schedules a retry or marks the job failed, before reaching any `sleep(STEP_MS)`. Failed attempts therefore take essentially zero processing time rather than failing at their first approximately 100 ms step.
   Fix: Perform the first step’s delay before checking the simulated failure, leaving progress at zero on failure and honoring shutdown during that delay.

## Rules

- The same rules as before apply: work only inside this repository and do not modify anything under `checks/` or the fixed files.
- You have at most 10 minutes for this stage.
- When you are done, make sure the application builds and starts as the task describes, then stop. Reply with a short summary of what you changed.

The repository includes fixed build, smoke, and contract checks (`npm run build`, `npm run check:smoke`, `npm run check:contract`). You may run them yourself. When you finish, the runner will also run them, and if any fail you may receive their output and a limited number of chances to repair. Passing these checks does not guarantee acceptance: a separate, hidden evaluation decides that.
