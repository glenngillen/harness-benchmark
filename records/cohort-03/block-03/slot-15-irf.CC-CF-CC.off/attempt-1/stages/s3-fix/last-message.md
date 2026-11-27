Addressed all three findings:

- Worker recovery resumes an interrupted attempt without falsely failing it or incrementing its attempt count.
- The form uses `novalidate` so invalid values reach API validation.
- Request body validation now runs even when the idempotency key is invalid, combining field errors.

`npm run build` passes. I verified an interrupted third attempt completed after worker restart. Server startup and the provided checks remain unverified because this sandbox rejects local port binding with `EPERM`.