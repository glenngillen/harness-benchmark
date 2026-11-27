Both findings are fixed and verified. The build passes, and the smoke and contract checks pass (2/2 and 5/5).

**Changes**

- **Recovery (`src/worker.ts`)**: a job left `running` is now handled by what its interrupted attempt was.
  - If the attempt was a simulated failure (`attempts <= failAttempts`), its failure outcome is applied. It is requeued with a delay if attempts are below 3, and otherwise becomes `failed` with `"transient failure"`.
  - If the attempt was successful processing, the job is requeued and processed again from the start.
- **String storage (`src/db.ts`, `src/server.ts`, `src/worker.ts`)**: `input` and `result` are stored as JSON-encoded strings, in columns `input_json` and `result_json`. Every read, payload comparison, and write goes through `JSON.parse` or `JSON.stringify`.

**Verification**

- Recovery: I seeded three interrupted jobs with no worker running, then started the worker.
  - `attempts: 3, failAttempts: 3` became `failed`, `"transient failure"`, `attempts: 3`.
  - `attempts: 2, failAttempts: 3` was retried and failed on attempt 3.
  - `attempts: 1, failAttempts: 0` was reprocessed and completed as `"HELLO"`.
- Strings: input `"a\u0000b\ud800"` was stored and returned intact. The replay with the same key returned 200 with the same job. It completed with output `"A\u0000B\ud800"`.

**Things to know**

- The schema changed (`input` became `input_json`, `result_output` became `result_json`). A database file created by the earlier version won't work with this code, so delete any old `data/jobs.db` before running.
- One SQL quoting slip in my seed script caused an error on a single statement. That job was already in the state I wanted, so the results above still stand.