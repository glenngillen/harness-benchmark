All four review findings are fixed. The build is clean, smoke passes 2/2, and contract passes 5/5. I also ran targeted end-to-end tests for the review cases, and all of them behaved as specified.

**What changed**

1. **Input corruption (`src/db.ts`, `src/server.ts`, `src/worker.ts`)**: `input` and `output` are now stored as JSON text (`input_json`, `output_json`) and decoded on read. A round-trip of `a\u0000b\ud800x` now returns the exact input and the output `A\u0000B\ud800X`.
2. **Retry bypass (`src/worker.ts`)**: an interrupted attempt is now un-counted on recovery and on clean shutdown, so it resumes under the same attempt number and its retry rule applies unchanged. A job interrupted during attempt 3 with `failAttempts: 3` now ends `failed` with `attempts: 3`. I also added a guard that fails any job asked to run beyond the limit.
3. **Creation race (`src/server.ts`)**: the new row is read inside the transaction, before `COMMIT`, so the 201 response is always the queued representation.
4. **Numeric input (`ui/index.html`)**: number fields use `valueAsNumber`, so `1e1` is sent as `10`. Values that do not parse are still sent as raw strings, so the API still rejects them.

**Note on the change itself:** my first attempt at fix 2 broke the retry contract check. The shared requeue statement was un-counting attempts after a simulated failure too, so attempt 1 repeated forever. I split the statements: failures keep their count, and only interrupted attempts are un-counted. The contract check is back to 5/5.

**Note:** the column rename means a SQLite file created by the earlier version will not work with this code. The repo has no such file, so nothing in it needs migrating.