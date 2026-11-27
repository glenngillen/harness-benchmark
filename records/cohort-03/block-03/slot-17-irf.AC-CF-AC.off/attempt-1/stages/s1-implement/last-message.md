The job tracker is implemented and builds. Both fixed checks pass: smoke 2/2 and contract 5/5. I didn't commit anything.

**What changed**

- **`src/db.ts`**: opens the SQLite database in WAL mode and creates the `jobs` and `worker_heartbeat` tables. Both processes call it.
- **`src/server.ts`**: the HTTP API.
  - Validation collects every offending field and returns `400 invalid_request` with the field names.
  - Idempotency keys are checked and stored in the database inside a `BEGIN IMMEDIATE` transaction, so replays survive restarts.
  - `/health` reports the worker as up if its heartbeat is less than 3 seconds old.
  - Serves `ui/index.html` at `/`.
- **`src/worker.ts`**:
  - Claims the oldest queued job and runs it at 100 ms per step, writing progress after each step.
  - Simulated failures retry after a 500 ms delay, up to 3 attempts, then end as `failed` with `"transient failure"`.
  - Heartbeats every second.
  - On startup, any job left `running` goes back to `queued`.
- **`ui/index.html`**: the form and job list with all the required `data-testid` attributes. It polls `/api/jobs` every second and renders with `textContent`, so job input can't inject markup.

**Manual checks** (on a scratch database)

- Malformed JSON, wrong types, out-of-range values, unknown fields, a bad `Idempotency-Key`, and a wrong `Content-Type` all return 400 with the right field.
- A keyed job replayed after a restart returns the same job, and a different payload returns 409.
- Killing both processes with `SIGKILL` mid-job and restarting completes the job with the correct output.
- `SIGTERM` stops both processes cleanly.

I did not open the UI in a browser. I only checked that every `data-testid` is present in the HTML.

**Choices you may want to review**

- A job interrupted by a crash keeps the interrupted attempt in `attempts`, so the rerun is attempt n+1. This matches "attempts started so far", but a hidden test could expect the other reading.
- In the form, empty steps or fail-attempts fields are omitted so the server defaults apply. Non-numeric text is sent as text so the API rejects it and names the field.

**Things to know**

- Port 3917 was already in use by a process outside this sandbox, so my first manual run failed with `EADDRINUSE`. I didn't touch that process and reran on another port.
- `git status` shows untracked dotfiles and directories (`.bashrc`, `.github`, `scripts`, and others). I didn't create them, and I left them alone.