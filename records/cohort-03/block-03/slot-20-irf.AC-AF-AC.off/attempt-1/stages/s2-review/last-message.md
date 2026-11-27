# Review findings

1. [major] src/server.ts:103-112 — The idempotency check and the insert are two separate steps, so they can race. If two requests with the same new `Idempotency-Key` arrive at the same time, both find no existing job and both try to insert. The `UNIQUE` constraint on `idempotency_key` stops a second job from being created. But the losing request throws, the catch at line 148 turns that into a `500 internal_error`, and the client never gets the expected `200` replay or `409` conflict.
   Evidence: `findJobByKey` followed by `insertJob`, with no transaction and no handling of the constraint error. A concurrent replay of a valid submission gets a 500.
   Fix: Wrap lookup and insert in `BEGIN IMMEDIATE … COMMIT`. Or catch the `SQLITE_CONSTRAINT` / UNIQUE error from `insertJob`, look the key up again, and return 200 or 409 with the same payload comparison.

2. [major] src/jobs.ts:167-175 + src/worker.ts:45-48 — A worker crash can push `attempts` above 3. `requeueInterrupted` sends `running` jobs back to `queued` but keeps `attempts`, and `claimNextJob` then adds 1 again. So a job that was killed during attempt 3 (for example `failAttempts: 2`, killed mid-steps) is retried as attempt 4. The spec allows at most 3 attempts in total. Also, `failJob` writes `job.attempts`, which can be 4 here, while the spec requires the final `attempts` to be 3.
   Evidence: `claimNextJob` has no `attempts < MAX_ATTEMPTS` guard. `failJob(db, id, 'transient failure', job.attempts)` uses whatever count it is given.
   Fix: In `requeueInterrupted`, mark jobs with `attempts >= MAX_ATTEMPTS` as `failed` (error `"transient failure"`, attempts 3), or make the worker do this when it claims such a job. Cap the stored attempts at `MAX_ATTEMPTS`. Decide clearly whether a crashed attempt counts toward the 3, and apply that rule in one place.

3. [minor] src/worker.ts:54-57, src/jobs.ts:158-164 — On a graceful stop, `revertToQueued` subtracts 1 from `attempts`. The spec defines `attempts` as "the number of processing attempts started so far", and a client may already have seen the higher value. A counter that goes down breaks that definition and treats SIGTERM differently from SIGKILL, which keeps the count.
   Fix: Leave `attempts` as it is on revert. Handle the 3-attempt cap as described in finding 2.

4. [minor] src/server.ts:143 — `decodeURIComponent` throws on a malformed percent-encoding such as `/api/jobs/%E0%A4%A`, and the request gets a `500` instead of `404 not_found`.
   Fix: Wrap the decode in try/catch and return 404 `not_found` if it fails.

5. [minor] ui/index.html:58-62 — `fieldValue` leaves out empty numeric fields, so the API fills in its defaults. It also converts strings like `"0x10"` or `"1e1"` to numbers, which can turn invalid input into a valid number. The spec says the form sends the field values so that the API's validation applies. Silently using defaults or converting hex/exponent strings can hide rejections the evaluator expects to see in `form-error`.
   Fix: Convert only plain decimal strings (`/^-?\d+(\.\d+)?$/`) to numbers and send anything else as a string. Consider sending an empty field as `""` (which the API rejects) instead of leaving it out, or make the inputs `type="number"`, so the user sees what was sent.

I could only read the code in this session, so I did not build, start or call the app. Everything above comes from reading the source. Request routing, validation rules, the processing and retry timings, heartbeat and health, SIGTERM handling, WAL/busy_timeout setup and the UI test IDs and polling all looked correct against the spec.