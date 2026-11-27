The job tracker is implemented. `npm run build` is clean, and both fixed suites pass: smoke 2/2 and contract 5/5. Nothing is committed; the changes are in the working tree.

**What changed** (only `src/db.ts`, `src/server.ts`, `src/worker.ts` and `ui/index.html`):
- **`src/db.ts`**: schema creation (`initSchema`, idempotent), the job row and API shape conversion, and a `BEGIN IMMEDIATE` transaction helper.
- **`src/server.ts`**: a `node:http` router, strict validation that collects every field error, idempotent create inside a transaction, health from the worker heartbeat, the UI served at `/`, and JSON for every response including 404/405/500. On `SIGTERM` it closes connections and exits 0.
- **`src/worker.ts`**: a heartbeat every second, startup recovery of `running` jobs, a claim loop over the oldest queued job, progress writes after each step, retries with a 500 ms `available_at` delay, and a graceful stop on `SIGTERM` that exits 0.
- **`ui/index.html`**: the form, list and status elements with the required `data-testid`s. It polls every second and uses `textContent` only.

**Manual checks against a fresh database (all as specified):**
- Validation: each bad input gets 400 with the right `fields` entry, and no job is created.
- Idempotency: the same key and payload gives 201 then 200. A different payload gives 409. The replay still returns 200 after a server restart.
- Retries: `failAttempts` 1 completes at attempt 2, 2 completes at attempt 3, and 3 ends `failed` with `"transient failure"`.
- Health: `up` while the worker runs, and `down` after `SIGKILL`.
- Crash recovery: I killed the worker at progress 1/20. After restart the job completed with `attempts` 1, which means the interrupted attempt was re-run under its own number.
- Start order: the worker started first against a directory that didn't exist, and it was created.
- Shutdown: both processes exit 0 on `SIGTERM`.

**Choices I made:**
- The job input is a text `<input>`, not a textarea, since the spec says "text field". I left out `maxlength` so the API's 1000-character rule is what rejects long input.
- A graceful worker stop deletes its heartbeat row, so `/health` reports `down` immediately rather than after 3 s.
- On a graceful stop, or when recovering a job after a crash, the interrupted attempt is not counted, so `attempts` never exceeds 3.

**Not verified:** there is no browser in this environment, so I haven't exercised the page itself. I checked that the inline script parses, that the required `data-testid`s are present, and that `/` serves HTML. The polling, form errors and progress display are untested in a real browser.