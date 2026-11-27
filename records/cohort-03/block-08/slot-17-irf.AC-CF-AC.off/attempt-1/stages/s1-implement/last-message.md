The job tracker is implemented. `npm run build` is clean, and both fixed check suites pass (smoke 2/2, contract 5/5). I also ran an end-to-end script on a private port covering validation, idempotency, retries, and SIGKILL recovery, and all of it behaved as specified. I did not commit anything.

**What changed**

- **`src/db.ts`**: creates the schema (`jobs`, `idempotency`, `heartbeats`) on open, and maps rows to the public job JSON.
- **`src/validation.ts`** (new): request validation. Collects every offending field and covers unknown fields, wrong types, ranges, bad JSON, non-object bodies, Content-Type, and the `Idempotency-Key` format.
- **`src/server.ts`**: the HTTP API, with 404/405 handling, idempotent creation in a `BEGIN IMMEDIATE` transaction, and `/health` reporting the worker as `up` only if its heartbeat is under 3 s old. Serves `ui/index.html` at `/`. Exits cleanly on SIGTERM/SIGINT.
- **`src/worker.ts`**: polls the queue every 200 ms, oldest first. It runs 100 ms steps, updates progress after each step, and handles simulated failures with up to 3 attempts. It writes a heartbeat every second.
- **`ui/index.html`**: the form, error region, and job list with all the required `data-testid` attributes. It polls every second.

**Choices I made where the brief left room**

- On worker startup, any job left `running` is requeued. This assumes a single worker, which is how the brief reads.
- On clean shutdown, an in-flight job is requeued rather than left `running`.
- Retry delay is a fixed 500 ms, which is inside the 250 ms–2 s window.
- Request bodies over 64 KB are rejected with `invalid_request`.

**Things to know**

- Port 3917 was already occupied by a server I did not start, with another database. I left it alone and tested on port 3931. Running `ps` showed nothing, so I could not identify the owner.
- The repo root has untracked files I did not create (`.bashrc`, `.github`, `scripts`, and others). I left them untouched.