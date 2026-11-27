The job tracker is implemented. `npm run build` is clean, and both fixed suites pass: smoke 2/2 and contract 5/5.

**Changes**
- **`src/db.ts`**: opens the database, creates the `data/` parent directory if needed, sets WAL and a busy timeout, and creates the `jobs` and `heartbeats` tables.
- **`src/store.ts`** (new): all SQL. Jobs are ordered by an autoincrement `seq`, the worker claims jobs atomically, and idempotency keys are a unique column.
- **`src/server.ts`**: routing, validation, idempotency, and the `/health`, `/`, and `/api/jobs` endpoints.
- **`src/worker.ts`**: claims the oldest due job, runs one step per 100 ms, writes progress after each step, retries failed attempts after 500 ms, and writes a heartbeat every second.
- **`ui/index.html`**: the form, the job list with all required `data-testid` attributes, and a poll every second.

**Manual checks beyond the fixed suites**
- `failAttempts: 3` ends `failed` with `attempts: 3` and `error: "transient failure"`. `failAttempts: 2` completes on attempt 3.
- Validation rejects unknown fields, malformed JSON, non-object bodies, a missing Content-Type, bad `Idempotency-Key` values, and out-of-range or non-integer numbers, and it names each field.
- Idempotent replay returns 200 with the same job, and a different payload returns 409.
- `kill -9` on the worker makes `/health` report `"worker": "down"` within 3 s. After restart, the worker finishes the interrupted job and the data survives a server restart.

**Choices I made where the spec was open**
- A fixed 500 ms retry delay.
- A job interrupted by a crash keeps its attempt count and runs again as the next attempt. A graceful SIGTERM mid-attempt undoes that attempt's count.
- A Content-Type or malformed-body error uses the field name `"body"`.
- Request bodies are capped at 64 KB.

**Things to know**
- My first manual run failed because port 3917 was already in use by another process, so I reran on a free port. Nothing else of mine was affected.
- `git status` shows untracked dotfiles and folders (`.bashrc`, `.github`, `scripts`, and others) that I did not create. I left them alone. Changes are uncommitted, as you did not ask for a commit.