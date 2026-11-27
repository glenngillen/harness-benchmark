Both findings were correct, and I've fixed them. The build passes, and the smoke (2/2) and contract (5/5) checks pass.

- **Restart recovery bypassed the attempt limit (`src/worker.ts`).** On startup, running jobs whose `attempts` already reached 3 now fail with `"transient failure"` and keep `attempts: 3`. Only the remaining running jobs are requeued. The restart fixture (`running`, `attempts: 3`, `failAttempts: 3`) now ends `failed` with `attempts: 3`, not `completed`.
- **Lossy text storage (`src/db.ts`, `src/jobs.ts`, `src/server.ts`, `src/worker.ts`).** `input` and `result` are stored as JSON text (`input_json`, `result_json`) and decoded when read. `JSON.stringify` escapes NUL characters and lone surrogates, so they survive. I checked the `"a\u0000b\ud800c"` input: it round-trips through submission and processing, and the output is `"A\u0000B\ud800C"`.

The renamed columns only affect fresh databases. A database created by the previous code would need to be deleted; I did not add a migration.

I did not re-test a restart with the NUL input after the restart fixture, so the NUL/surrogate check covers submission and processing but not a restart.