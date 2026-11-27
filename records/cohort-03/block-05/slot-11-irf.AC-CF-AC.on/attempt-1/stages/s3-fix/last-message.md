All three findings are addressed. The build passes, `check:smoke` passes 2/2, and `check:contract` passes 5/5.

**Changes:**

1. **Attempt counting on restart (`src/worker.ts`):** recovery no longer subtracts an attempt. A job that was `running` when the worker died is requeued with its `attempts` unchanged, so the next claim starts `attempts + 1`. Repeated crashes therefore keep counting toward the three-attempt limit. If the interrupted attempt was already attempt 3, the job is marked `failed` with `"transient failure"`, because no further attempt is allowed. Verified: a job crashed twice mid-run completed with `attempts: 3`.

2. **Lossless input and output (`src/db.ts`, `src/server.ts`, `src/worker.ts`):** the columns are now `input_json` and `output_json`, holding `JSON.stringify` output. This escapes NUL and lone surrogates, so they round-trip exactly. The worker decodes the input, uppercases it, and encodes the output. Verified: `"a\u0000b\ud800c"` came back unchanged, with output `"A\u0000B\ud800C"`.

3. **Creation response (`src/server.ts`):** the insert uses `INSERT ... RETURNING *`, and the `201` body is built from that returned row. It can't show a state the worker set afterwards.

**Schema change:** the column renames mean a database file created by the previous build won't match. The checks use fresh databases, so this doesn't affect them. Delete any old `data/jobs.db` before running.

I didn't add a separate test for the creation race in finding 3. The `RETURNING` change removes the window between insert and read.