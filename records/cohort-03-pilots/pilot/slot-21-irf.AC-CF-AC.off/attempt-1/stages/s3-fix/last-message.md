All four findings are fixed, and both fixed suites still pass (smoke 2/2, contract 5/5).

**Changes:**
1. **Lossless text (`src/db.ts`, `src/server.ts`, `src/worker.ts`):** `input` and `result` are now stored as JSON text, which keeps NUL characters and lone surrogates intact. They are decoded when read, and the idempotent-replay comparison uses the decoded value. Confirmed: `"hello\u0000world\ud800"` comes back unchanged, and an identical replay returns 200 rather than a conflict.
2. **Combined field errors (`src/validate.ts`):** the `Idempotency-Key` check now runs independently of the body checks, and a bad Content-Type or malformed body no longer hides it. Confirmed: a malformed body with a bad key lists both `Idempotency-Key` and `body`.
3. **First-step duration (`src/worker.ts`):** a simulated failure now waits one 100 ms step before failing, with progress still at zero. The retry delay is unchanged. Confirmed: the retry began about 1.1 s after submission, which is consistent with a 100 ms first step, a 500 ms retry delay, and up to 200 ms pickup polling.
4. **Body-size limit removed (`src/server.ts`):** the 64 KB cap is gone, so a 64 KB+ body with leading whitespace is accepted. Confirmed: it returns 201.

I did not decline any finding. The one side effect of the storage change is that a database created before this change would not decode. There was no existing deployment to migrate, so I did not add a migration. I have not committed anything.