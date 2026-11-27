The job tracker is implemented. `npm run build` passes, and both fixed suites pass: smoke 2/2 and contract 5/5. I haven't committed anything.

**What changed**
- `src/jobs.ts` (new): job types, limits, and `validateSubmission`. It reports every field error, uses `Object.keys` to catch unknown fields, uses `.length` for input length, and never coerces values.
- `src/db.ts`: `openDatabase` is unchanged. Added the idempotent schema, a `JobStore` class with prepared statements, `BEGIN IMMEDIATE` transactions that never span an `await`, and `toJob`, the only place the public shape is built.
- `src/server.ts`: routing on the path with 404/405 handling, body reading with a 64 KiB cap, idempotent creation that returns 201 or 200 or 409, health from the heartbeat (up if it is at most 3 s old), a 500 fallback, and a bounded graceful shutdown.
- `src/worker.ts`: a heartbeat every 500 ms that runs independently of processing, interrupted-job recovery before new claims, one attempt at a time with progress written per step, simulated failures at the first step, a 500 ms requeue delay persisted in `available_at`, and clean SIGTERM/SIGINT handling that removes the heartbeat.
- `ui/index.html`: the required `data-testid` elements, `novalidate`, a `role="alert"` error region with field-level messages, DOM rendering with `textContent`, and a non-overlapping 400 ms poll loop.

**Choices I made**
- Retry delay is a fixed 500 ms.
- An empty or non-numeric steps/failAttempts field is sent as its raw string, so the API rejects it rather than the page defaulting it.
- Recovery replays an interrupted attempt from zero using its stored attempt number, so it never counts as an extra retry.

**Verification**
- Beyond the fixed checks, I ran a temporary end-to-end script against an isolated nested database. It covered validation boundaries (including emoji length), exact response shape, Unicode uppercasing, `failAttempts` 0 to 5, idempotency including concurrent same-key requests, routes, and ordering. It also covered SIGKILL of the worker mid-progress and during a third attempt, server restart with persisted IDs, health going down after SIGKILL, and clean SIGTERM exits. Everything passed. The one failure was my test helper always setting a JSON Content-Type; a raw curl request confirmed the server correctly rejects a missing Content-Type.

**Not verified**
- **The browser page.** No browser is available here. I only checked that the inline script parses and that the static `data-testid` attributes are present. Polling, form submission, and rendering are untested in a real browser.
- **Pickup latency.** I did not time idle pickup against the 1 s target directly. Polling every 100 ms makes it well under that, but it is unmeasured.