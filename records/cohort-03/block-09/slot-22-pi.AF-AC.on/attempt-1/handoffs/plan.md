# Plan

## Approach
Use one shared `src/db.ts` module that owns the schema, row-to-JSON mapping and SQL helpers. Both processes import it, and each runs idempotent `CREATE TABLE IF NOT EXISTS` at startup, so either can start first. The server is a plain `node:http` router with strict validation. Idempotency is enforced by a `UNIQUE` idempotency-key column plus a stored canonical payload, inside a `BEGIN IMMEDIATE` transaction. The worker is a single polling loop. It writes a heartbeat row every second, requeues any `running` jobs at startup, claims the oldest due queued job atomically, and writes progress after every 100 ms step. Retries reuse the same row, which waits in `queued` with a `run_after` timestamp. The UI is a single static HTML file with inline JS. It polls `GET /api/jobs` every second and uses `novalidate` so that invalid values reach the API.

## Files
- `src/db.ts`: keep `openDatabase` (it creates the parent directory, sets busy_timeout and WAL). Add `initSchema(db)`, the `JobRow` type, `toJob(row)`, and constants (`MAX_ATTEMPTS = 3`, `HEARTBEAT_STALE_MS = 3000`).
- `src/server.ts`: rewrite with routing, validation, idempotency, health, the static UI and SIGTERM handling.
- `src/worker.ts`: rewrite with heartbeat, recovery, the claim/process loop, retries and SIGTERM handling.
- `ui/index.html`: form, error region, job list and polling script. It stays at `ui/index.html` because the server reads it via `new URL('../ui/index.html', import.meta.url)`, which resolves correctly from `dist/`.

## Steps
1. **Schema** (in `initSchema`, run by both processes):
   ```sql
   CREATE TABLE IF NOT EXISTS jobs(
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL,
     fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
     progress_completed INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE, idempotency_payload TEXT);
   CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after, seq);
   CREATE TABLE IF NOT EXISTS heartbeat(name TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
   ```
   `toJob(row)` returns exactly the spec shape:
   - `failAttempts` comes from `fail_attempts`.
   - `progress` is `{completed: progress_completed, total: steps}`.
   - `result` is `{output}` when the job is completed, otherwise null.
   - `error` is the error string or null.
   - Timestamps are ISO strings from `new Date().toISOString()`.
   - Ordering always uses `seq` (newest first is `ORDER BY seq DESC`), because millisecond timestamps can tie.
2. **Server helpers:**
   - `send(res, status, body)` always sets `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - `readBody(req)` collects the chunks into a utf8 string.
3. **Routing** (`pathname` comes from `new URL`):
   - `/`: GET serves the HTML. Any other method → 405.
   - `/health`: GET only.
   - `/api/jobs`: GET or POST. Any other method → 405 `method_not_allowed`.
   - `/api/jobs/<id>` (regex `^/api/jobs/([^/]+)$`, decode the id): GET only, otherwise 405. An unknown id → 404 `not_found`.
   - Anything else → 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` as JSON.
4. **Health:** `SELECT at_ms FROM heartbeat WHERE name='worker'`. Report `worker: "up"` if the row exists and `Date.now() - at_ms <= 3000`, otherwise `"down"`.
5. **POST validation.** Collect a `fields` array and return it as a whole:
   - **Content-Type:** take the header, split on `;`, trim, lowercase. It must equal `application/json`. If not → 400 with field `body`, message "Content-Type must be application/json".
   - **Idempotency-Key:** if the header is present (`req.headers['idempotency-key'] !== undefined`, which includes an empty string) and fails `^[A-Za-z0-9_-]{1,128}$`, add field `Idempotency-Key`.
   - **Body:** `JSON.parse` failure → field `body`. Parsed value is null, an array or not an object → field `body`.
   - **Object fields:**
     - Each key outside {input, steps, failAttempts} → its own field entry.
     - `input`: must be `typeof 'string'`, with `length` 1–1000 and `trim().length > 0`.
     - `steps` / `failAttempts`: if present (`!== undefined`), must be `typeof 'number' && Number.isInteger(v)` and within range. Otherwise apply the default (5 / 0).
   - If `fields` is non-empty → 400 `invalid_request` with message "Invalid request" plus `fields`. Run the header and body checks together so that all problems are reported.
6. **Create / idempotency** (inside `db.exec('BEGIN IMMEDIATE')` … COMMIT, ROLLBACK on error):
   - Build the canonical payload `JSON.stringify({input, steps, failAttempts})` in a fixed key order, after defaults are applied.
   - If a key is present, `SELECT * FROM jobs WHERE idempotency_key=?`:
     - Found with the same payload → 200 `toJob`.
     - Found with a different payload → 409 `idempotency_conflict`.
   - Otherwise INSERT with:
     - `id = crypto.randomUUID()`, status `queued`, attempts 0, progress 0.
     - `run_after = 0`, `created_at = updated_at = now`.
     - The key and payload (NULL when there is no key; a UNIQUE column allows multiple NULLs).
   - Return 201 with the inserted row.
7. **GET list / get:** `{jobs: rows.map(toJob)}` ordered by `seq DESC`. Single job → the row or 404.
8. **Server shutdown:** on SIGTERM/SIGINT run `server.close()`, `server.closeAllConnections()`, `db.close()`, then `process.exit(0)`. Add a 2 s fallback `setTimeout(...).unref()` that also exits. Listen on `Number(process.env.PORT ?? 3000)`.
9. **Worker startup:**
   - `openDatabase()` + `initSchema`.
   - Write the heartbeat immediately (`INSERT ... ON CONFLICT(name) DO UPDATE SET at_ms=excluded.at_ms`), then every 1000 ms via `setInterval`.
   - **Recovery:** `UPDATE jobs SET status='queued', progress_completed=0, attempts=MAX(attempts-1,0), run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is voided, so it re-runs as the same attempt number and the "attempt n fails if n ≤ failAttempts" and 3-attempt rules stay consistent.
10. **Worker loop** (`while (!stopping)`):
    - **Claim:**
      ```sql
      UPDATE jobs SET status='running', attempts=attempts+1, progress_completed=0, updated_at=?
      WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1)
      RETURNING *
      ```
      Use `.get()`. If no row is returned, sleep 200 ms and loop again.
    - **Process the claimed row** (`n = attempts`):
      - **Failing attempt:** if `n <= fail_attempts`, the attempt fails at its first step with progress still 0. Sleep about 100 ms first so it behaves like a step.
        - If `n >= 3`: `status='failed', error='transient failure', result_output=NULL`.
        - Otherwise: `status='queued', run_after=Date.now()+500, progress_completed=0`.
      - **Normal attempt:** for i = 1..steps, sleep 100 ms, then `UPDATE ... SET progress_completed=i, updated_at=? WHERE id=? AND status='running'`. Then `status='completed', result_output=input.toUpperCase(), progress_completed=steps, error=NULL`.
    - If `stopping` becomes true mid-job, break out of the step loop and leave the row `running`. Startup recovery handles it.
11. **Worker shutdown:**
    - SIGTERM/SIGINT sets `stopping = true`.
    - Make the sleeps abortable via an `AbortController` (`sleep(ms, undefined, {signal})`, catching AbortError) so the process exits in under 1 s.
    - After the loop: `clearInterval`, `db.close()`, `process.exit(0)`.
12. **UI** (`ui/index.html`):
    - **Markup:**
      - `<form data-testid="job-form" novalidate>`.
      - `<textarea|input data-testid="job-input">`.
      - `<input type="number" data-testid="job-steps" value="5">` and `<input type="number" data-testid="job-fail-attempts" value="0">`.
      - `<button type="submit" data-testid="job-submit">`.
      - `<div data-testid="form-error" role="alert"></div>`.
      - `<ul data-testid="job-list">`.
    - **On submit** (`preventDefault`):
      - Build the payload: `input` is sent raw. For each numeric field, a trimmed empty value is omitted. Otherwise `Number(v)` is sent if it is finite, else the raw string, so the API rejects it.
      - POST with `Content-Type: application/json`.
      - If `!res.ok`: render `error.message` plus one line per field, `"<field>: <message>"`, into form-error.
      - On success: clear form-error, clear the input field, refresh the list immediately.
    - **Rendering:**
      - `refresh()` fetches `/api/jobs` every 1000 ms (`setInterval`) and on load.
      - Each job renders as `<li data-testid="job-item" data-job-id=id>` with spans `job-status`, `job-progress` (`${completed}/${total}`) and `job-result` (result.output if completed, error if failed, else ''), plus the input text.
      - Set all values via `textContent`, never `innerHTML` with user data. Keep server order (newest first).
13. Run `npm run build`, then `npm run check:smoke` and `npm run check:contract`.

## Behaviours to verify
- **Build and startup:** run `npm run build && npm run check:smoke && npm run check:contract`. All checks should pass.
- **Health:** start only the server and `curl /health` → `worker:"down"`. Start the worker → `"up"` within about 1 s. Kill the worker → `"down"` after more than 3 s.
- **Validation:** curl POSTs, each expecting 400 with the fields shown and `GET /api/jobs` count unchanged:
  - no Content-Type, `text/plain`, `{bad`, `[]`, `"x"` → field `body`;
  - `{"input":"   "}` → `input`;
  - `{"input":"a","steps":"3"}` → `steps`;
  - `steps: 0 / 21 / 2.5` → `steps`;
  - `{"input":"a","x":1}` → `x`;
  - `Idempotency-Key: bad key!` → `Idempotency-Key`.
- **Idempotency:** POST `{"input":"a"}` with key K → 201. POST `{"input":"a","steps":5,"failAttempts":0}` with K → 200, same id. POST `{"input":"b"}` with K → 409. Restart the server and repeat → still 200 and the same id.
- **Processing:** POST `steps: 10` and poll the job every 200 ms. `progress.completed` should climb, then the job is `completed` with output = input uppercased (try `"straße"` → `"STRASSE"`).
- **Retries:** `failAttempts: 1` → completed with attempts 2. `failAttempts: 2` → completed with attempts 3. `failAttempts: 3` → failed, `error "transient failure"`, attempts 3, result null. The job count grows by 1 each time.
- **Crash recovery:** POST `steps: 20`. While it is running, `kill -9` the worker, then restart it → the job completes within a few seconds. Completed jobs keep the same `updatedAt`, which shows they were not reprocessed.
- **Clean shutdown:** `kill -TERM` each process → it exits with code 0 within 1–2 s.
- **UI:** open `/` and submit `steps 0` → form-error shows "steps". Submit a valid job → it appears at the top and status/progress update live.

## Risks
- **Browser validation:** without `novalidate` (or with `min`/`max`/`required` attributes), the browser blocks submission and form-error stays empty. Don't add constraint attributes, or keep `novalidate`.
- **Content-Type with charset:** `application/json; charset=utf-8` must be accepted. Parse the media type and don't compare the whole header string.
- **Idempotency race and replay order:** concurrent submissions with one key can create duplicates. Use `BEGIN IMMEDIATE` plus the UNIQUE column. Validate first: an invalid body with a known key is still a 400.
- **Newest-first ordering:** use `seq` instead of `created_at`, which can tie.
- **Lock contention:** server and worker share the file. Keep transactions short, and keep `busy_timeout` set before WAL as `db.ts` already does.
- **SIGTERM hang:** keep-alive HTTP connections or a pending `setInterval` keep the process alive. Call `closeAllConnections`, clear the timers, and call `process.exit`.
- **Crash-recovery attempt counting:** without 
[truncated]