# Review findings

1. [major] src/server.ts:24 — Request chunks are decoded independently, corrupting valid Unicode input.
   Evidence: Invoking the request handler with `{"input":"café"}` split between the two UTF-8 bytes of `é` returned `201` with input `"caf��"`. HTTP chunk boundaries can occur anywhere. This violates exact input storage and also changes output and idempotency comparisons.
   Fix: Buffer the bytes and decode once, or use a streaming UTF-8 decoder such as `req.setEncoding('utf8')`.

2. [major] src/server.ts:31 — An unknown request path can crash the server instead of returning JSON.
   Evidence: Passing the origin-form path `//[` to the handler throws `Invalid URL`: `new URL` interprets it as an invalid authority. The async request callback has no rejection handler, so this becomes an unhandled rejection.
   Fix: Parse request targets as paths without interpreting leading double slashes as an authority, and handle parsing failures with the required JSON response.

3. [major] src/worker.ts:22 — Restarted processing attempts are not counted.
   Evidence: Startup requeues running jobs with `resume_attempt=attempts`. The next claim retains that count while resetting progress to zero and processing every step again. A job interrupted during attempt 1 can therefore complete after another full processing attempt while still reporting `attempts: 1`, contrary to the required increment when an attempt starts.
   Fix: Count restarted attempts when transitioning back to `running`, and apply the retry limit and simulated failure rules consistently to that count.

4. [minor] ui/index.html:17 — Native form validation prevents fractional values from reaching API validation.
   Evidence: Both numeric inputs have the default integer step constraint, and the form lacks `novalidate`. Entering `1.5` blocks the submit event, so no API request occurs and `form-error` never displays the offending field as required.
   Fix: Add `novalidate` to the form so submitted numeric values reach the API and its validation errors appear in the alert region.

5. [minor] src/worker.ts:19 — Jobs created within the same millisecond can run out of submission order.
   Evidence: Queue selection sorts by `created_at,id`. Timestamps have millisecond precision, while IDs are random UUIDs, so tied timestamps are ordered randomly rather than oldest first.
   Fix: Use insertion order as the tie-breaker, such as `ORDER BY created_at, rowid`, consistent with the insertion ordering used by the jobs list.