The reviewer's finding is fixed, and I reproduced it on a seeded database before and after the change. `npm run build` passes, and both fixed suites pass (smoke 2/2, contract 5/5).

**Changes in `src/worker.ts`:**
- **Simulated failures are decided at claim time.** `claim()` now counts the attempt and, if the attempt is a simulated failure, records the retry or the final failure in the same transaction. A failing attempt never sits in `running`, so a crash can't leave one half-counted.
- **Recovery handles interrupted failing attempts.** On startup, a `running` job whose attempt was due to fail is resolved by the normal rule: it becomes `failed` with `"transient failure"`, a null result, and `attempts: 3` if it was on its third attempt. Otherwise it is requeued with its attempt count unchanged. This also covers rows that an older build already left in `running`.

**Reproduction (seeded `running` rows, then worker started):**
- `attempts: 3, failAttempts: 3` → `failed`, `attempts: 3`, `"transient failure"`. This was the reviewer's case; before the fix it completed with `attempts: 4`.
- `attempts: 1, failAttempts: 3` → `failed`, `attempts: 3`.
- `attempts: 2, failAttempts: 1` → completes on attempt 3.
- `attempts: 1, failAttempts: 0`, interrupted mid-run → resumes and completes.

I did not commit. The working tree still has the untracked files that were already there before my work.