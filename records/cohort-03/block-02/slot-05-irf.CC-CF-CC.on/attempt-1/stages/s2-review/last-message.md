# Review findings

1. [major] src/server.ts:95 — A malformed percent-encoded job URL can terminate the server.
   Evidence: Calling the request handler with `GET /api/jobs/%` rejects with `URIError: URI malformed`. `decodeURIComponent` is unguarded, and the async HTTP listener has no rejection handler, so this becomes an unhandled rejection.
   Fix: Catch decoding errors and return a JSON `404 not_found` response. Ensure unexpected request-handler failures also produce a JSON response without terminating the process.

2. [major] ui/index.html:18 — Native form validation prevents invalid values from reaching the API.
   Evidence: The form lacks `novalidate`, while its fields use `required`, `min`, `max`, and `step`. Submitting steps `21` or `1.5`, for example, prevents the submit listener from running. No API request occurs, and `form-error` never displays the required field-specific rejection.
   Fix: Add `novalidate` to the form so submissions reach the existing API validation and error-rendering code.

3. [major] src/server.ts:79–90 — Creating a job can return its running state instead of the required queued state.
   Evidence: The insert commits before the separate SELECT used to construct the `201` response. The worker can claim the new row between those statements, causing the response to contain `status: "running"` and `attempts: 1`, contrary to the creation-response contract.
   Fix: Capture the inserted row atomically with `INSERT ... RETURNING *` and build the creation response from that snapshot.