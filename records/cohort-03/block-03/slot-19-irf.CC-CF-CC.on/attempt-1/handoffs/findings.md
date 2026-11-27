# Review findings

1. [major] src/server.ts:18 — Decoding each request chunk separately corrupts valid Unicode input.
   Evidence: An in-memory request-handler test split the UTF-8 bytes of `é` across two chunks. The API returned `201` with input `"��"` instead of `"é"`. Replaying the identical payload in one chunk with the same idempotency key returned `409`.
   Fix: Decode with a streaming UTF-8 decoder, set the request encoding to UTF-8, or concatenate buffers before decoding.

2. [major] src/worker.ts:10 — Restart recovery decrements the durable attempt count.
   Evidence: Recovery explicitly subtracts one before starting processing again. Testing recovery from a `running` job with `attempts: 1` produced a completed job still reporting `attempts: 1`, although two processing attempts had started. This contradicts the defined attempt count and allows repeated restarts to evade attempt accounting.
   Fix: Preserve the recorded attempt count during recovery, increment it when another attempt starts, and enforce the retry limit consistently.

3. [major] ui/index.html:18 — Native form validation prevents invalid values from reaching API validation.
   Evidence: The form lacks `novalidate`, while its inputs use `required`, `min`, `max`, and `step` constraints. Submitting values such as `steps: 0` or `steps: 1.5` prevents the submit handler from running, so no API request occurs and `form-error` does not show the required field rejection.
   Fix: Add `novalidate` to the form so submissions reach the existing API handler and its field errors appear in the alert region.