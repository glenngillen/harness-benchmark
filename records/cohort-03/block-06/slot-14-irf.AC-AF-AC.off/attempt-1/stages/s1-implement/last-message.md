The job tracker is implemented in `src/` and `ui/`. `npm run build` passes, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I also tested beyond those suites by hand.

**What I verified**
- **Validation and routing:** unknown fields, `"3"` for steps, non-integers, malformed JSON, non-object bodies, a wrong or missing Content-Type, and a bad `Idempotency-Key` all return 400 with the right `fields`. Unknown paths return 404 and wrong methods return 405.
- **Retries:** `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`.
- **Idempotency:** a replay returns 200, a different payload returns 409, and a key survives a server `SIGKILL` restart without creating a second job.
- **Crash recovery:** I `SIGKILL`ed the worker mid-job. Health went to `worker: down` about 3.5 s later. After a restart the job completed with the correct output, and it also survived a server `SIGKILL`.
- **Shutdown:** SIGTERM exits in 7 ms for the server and 71 ms for the worker.

**Design choices you may want to check**
- **Retry delay:** 500 ms, a fixed value inside the 250 ms–2 s range.
- **Interrupted attempts:** a running job found at worker startup is requeued with `attempts` decremented by one. The interrupted attempt is then rerun under the same number, so the 3-attempt cap is not exceeded.
- **Heartbeat:** the worker writes one every second and clears it on clean shutdown, so health reports `down` immediately.
- **Body size:** bodies over 16 KB get a 400 `invalid_request` with field `body`. The spec does not cover this case.
- **Idempotency:** the key check and the insert run in one `BEGIN IMMEDIATE` transaction in `src/server.ts`.

**Not verified**
- I did not open the page in a real browser. I checked the `data-testid` attributes by grep, and the form and list logic by reading the code.

I did not commit. The changes are in the working tree: `src/db.ts`, `src/server.ts`, `src/worker.ts`, `src/jobs.ts` (new), and `ui/index.html`.