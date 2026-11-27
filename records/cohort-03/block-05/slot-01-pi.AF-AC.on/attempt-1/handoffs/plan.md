# Plan

## Approach
Put all shared persistence in `src/db.ts`: schema creation, row-to-JSON mapping and the heartbeat helpers. Both processes open the same SQLite file in WAL mode with a busy timeout. The server is plain `node:http` with a small router, strict validation, and idempotency enforced by a UNIQUE column inside a `BEGIN IMMEDIATE` transaction. The worker is a polling loop with three parts: it atomically claims the oldest eligible queued job, runs the steps with progress written to the database after each one, and writes a heartbeat row every 500 ms. The UI is one static HTML file with inline JS that polls `GET /api/jobs` every second. Keep the existing `.ts` import specifiers (`./db.ts`); `rewriteRelativeImportExtensions` turns them into `.js`.

## Files
- `src/db.ts`: keep `openDatabase` (mkdir, busy_timeout, WAL), then add `CREATE TABLE IF NOT EXISTS` for the schema. Also add the shared `Job` type, `rowToJob(row)`, `nowIso()`, and heartbeat read/write helpers.
- `src/server.ts`: rewrite with the router, validation, idempotency, error responses, HTML serving and SIGTERM handling.
- `src/worker.ts`: rewrite with recovery, claim loop, step processing, retries, heartbeat and SIGTERM handling.
- `ui/index.html`: add the form, the error region and the job list with all the required `data-testid`s, plus inline script.

## Steps
1. **Schema** (in `openDatabase`, run on every open so either process can start first):
   - `jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, steps INTEGER NOT NULL, fail_attempts INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, result_output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, idem_key TEXT UNIQUE, idem_payload TEXT)`
   - an index on `(status, run_after, seq)`
   - `heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), last_seen INTEGER NOT NULL)`, where `last_seen` is epoch ms.
   - `rowToJob` builds the exact JSON shape from the task:
     - `progress` is `{completed: progress, total: steps}`.
     - `result` is `{output}` only when status is `completed`, otherwise `null`.
     - `error` is the string only when status is `failed`, otherwise `null`.
2. **Server helpers:**
   - `send(res, status, body)` always sets `application/json; charset=utf-8`.
   - `sendError(res, status, code, message, fields?)`.
   - Read the body with a 1 MB cap; anything larger gets 400 `invalid_request` with field `body`.
3. **Router**, run on `new URL(req.url).pathname` with exact matches:
   - `/` accepts GET only and returns the HTML, read once at startup from `new URL('../ui/index.html', import.meta.url)`.
   - `/health` accepts GET only.
   - `/api/jobs` accepts GET and POST.
   - `/^\/api\/jobs\/([^/]+)$/` accepts GET only.
   - A known path with the wrong method gets 405 `method_not_allowed` with an `Allow` header. Anything else gets 404 `not_found`.
   - Wrap the handler in try/catch and return 500 `internal_error` as JSON.
4. **Validation** (`validate(headers, rawBody)`): collect a `fields[]` array.
   - If the `Idempotency-Key` header is present and fails `^[A-Za-z0-9_-]{1,128}$`, add `{field:'Idempotency-Key'}`.
   - Content-Type: take the media type before `;`, trim and lowercase it. If it is not `application/json` (including a missing header), add `body` and stop the body checks.
   - `JSON.parse` failure: add `body`. Parsed value is not a plain object (null, array, primitive): add `body`.
   - For each key not in {input, steps, failAttempts}, add a field entry with that key's name.
   - `input`:
     - It must be present and `typeof === 'string'`.
     - It must have `length` 1–1000 and `trim().length > 0`.
     - Store it untouched.
   - `steps` and `failAttempts`: if present, require `typeof === 'number' && Number.isInteger(v)` and the range (1–20 for steps, 0–5 for failAttempts). This rejects `"3"`, `3.5`, `null` and `true`. Apply the defaults 5 and 0.
   - If `fields` is non-empty, return 400 `{error:{code:'invalid_request', message:'Invalid request', fields}}`.
5. **Create the job** in `BEGIN IMMEDIATE` … `COMMIT`, with `ROLLBACK` in a catch:
   - Compute `canonical = JSON.stringify({input, steps, failAttempts})` after defaults.
   - If a key was sent, `SELECT` by `idem_key`:
     - Found with the same `idem_payload`: return 200 with that job.
     - Found with a different payload: return 409 `idempotency_conflict`.
   - Otherwise `INSERT` with `id = crypto.randomUUID()`, status `queued`, `attempts 0`, `progress 0`, the same `nowIso()` for created/updated, `run_after 0`, and the key and payload. Return 201.
   - The UNIQUE index on `idem_key` guarantees one job per key, including across restarts.
6. **Read routes:**
   - `GET /api/jobs` is `SELECT * FROM jobs ORDER BY seq DESC` and returns `{jobs}`.
   - `GET /api/jobs/:id` returns the job or 404 `not_found`.
   - `/health` reads `heartbeat.last_seen`. `worker` is `'up'` if `Date.now() - last_seen < 3000`, otherwise `'down'`.
7. **Server shutdown:** on SIGTERM/SIGINT, call `server.close()` and `server.closeAllConnections()`, then `db.close()` and `process.exit(0)`. Log `listening` to stdout.
8. **Worker startup:**
   - Write the heartbeat immediately with `INSERT … ON CONFLICT(id) DO UPDATE`, then every 500 ms with `setInterval`.
   - Recover interrupted work: `UPDATE jobs SET status='queued', attempts=MAX(attempts-1,0), progress=0, run_after=0, updated_at=? WHERE status='running'`. The interrupted attempt is rolled back, so attempts never exceed 3 and the failAttempts semantics stay deterministic.
9. **Worker loop** (`while (!stopping)`):
   - Claim atomically: `UPDATE jobs SET status='running', attempts=attempts+1, progress=0, updated_at=? WHERE seq=(SELECT seq FROM jobs WHERE status='queued' AND run_after<=? ORDER BY seq LIMIT 1) RETURNING *`.
   - If nothing was claimed, `await sleep(200)` and loop again.
   - **Process a claimed job:**
     1. `n = attempts`.
     2. `await sleep(100)` for the first step.
     3. If `n <= fail_attempts`, the attempt fails with progress still 0:
        - If `n < 3`: `status='queued', run_after=Date.now()+500`.
        - Otherwise: `status='failed', error='transient failure'`.
        - Update `updated_at` either way.
     4. Otherwise, for i = 1..steps: sleep 100 ms (already done for step 1), then `UPDATE progress=i, updated_at`.
     5. After the last step: `status='completed', result_output=input.toUpperCase(), progress=steps`.
   - Check `stopping` between steps. If it is set mid-job, requeue the job (`status='queued', attempts=attempts-1, progress=0`) and break.
10. **Worker shutdown:** the SIGTERM handler sets `stopping`. After the loop, `clearInterval`, write `last_seen=0`, `db.close()` and `process.exit(0)`. Also set a 4 s fallback `setTimeout(() => process.exit(0)).unref()` from the handler.
11. **UI** (`ui/index.html`):
    - `<form data-testid="job-form" novalidate>` containing:
      - a text input `job-input`
      - `<input type="number" data-testid="job-steps" value="5">`
      - `<input type="number" data-testid="job-fail-attempts" value="0">`
      - `<button data-testid="job-submit" type="submit">`
      - Use **no** `required`/`min`/`max`, so the API does the validating.
    - Put `<div data-testid="form-error" role="alert"></div>` and `<ul data-testid="job-list"></ul>` under the form.
    - **On submit:**
      1. `preventDefault`.
      2. Build the body as `{input, steps, failAttempts}`. A numeric field value is sent as `Number(v)` when `v.trim() !== '' && Number.isFinite(Number(v))`. An empty value is omitted; any other value is sent as the raw string so the API rejects it.
      3. `fetch` with `Content-Type: application/json`.
      4. If the response is not ok, set the form-error text to the message plus each `field: message`.
      5. If it is ok, clear the form-error and refresh the list now.
    - **Rendering:**
      - `refresh()` fetches `/api/jobs` and rebuilds the list in API order (newest first) using `textContent` only.
      - Each item is `<li data-testid="job-item" data-job-id=id>` with `<span data-testid="job-status">`, `<span data-testid="job-progress">${completed}/${total}</span>` and `<span data-testid="job-result">`. The result span holds `result.output` when completed, `error` when failed, otherwise empty.
      - Use `setInterval(refresh, 1000)`, plus one call on load.

## Behaviours to verify
- **Build and checks:** run `npm run build && npm run check:smoke && npm run check:contract`. Both should pass.
- **Health:** start only the server and curl `/health`; it should say `worker:"down"`. Start the worker; within 1 s it should say `"up"`. Kill the worker; after 3 s it should say `"down"` again.
- **Validation:** POST each of the following and expect 400 with the correct `fields`:
  - no Content-Type, or `text/plain`
  - `{bad json`, `[]`, `null`
  - `{"input":"a","x":1}` (field `x`)
  - `{"input":"a","steps":"3"}`, `steps:0`, `steps:21`, `steps:2.5`
  - `failAttempts:6`
  - `input:"   "`, input 1001 characters long, missing input
  - header `Idempotency-Key: a b`

  Then confirm `GET /api/jobs` count is unchanged.
- **Idempotency:**
  - `{"input":"a"}` with key K returns 201.
  - Repeating with `{"input":"a","steps":5,"failAttempts":0}` and K returns 200 with the same id.
  - `{"input":"b"}` with K returns 409.
  - Restart the server and replay; it should still return 200 with the same id.
- **Progress:** submit `steps:10` and poll `GET /api/jobs/:id` every 100 ms. You should see `running`, progress rising 1..10, then `completed` with output in uppercase. Also try `"ßtraße"` and compare against `toUpperCase()`.
- **Retries:**
  - `failAttempts:2` should end `completed` with `attempts:3`, passing through `queued` between attempts.
  - `failAttempts:3` should end `failed` with `error:"transient failure"`, `attempts:3` and `result:null`.
- **Crash recovery:** submit `steps:20`, `kill -9` the worker mid-run and restart it. The job should complete and keep its id. Completed jobs should keep their `updatedAt` unchanged.
- **Durability:** SIGKILL both processes, restart them, and confirm all jobs and statuses are still listed.
- **Routing:** `DELETE /api/jobs` and `POST /health` return 405; `/nope` and `/api/jobs/unknown` return 404. All of them must be JSON.
- **SIGTERM:** both processes exit within about 1 s of `kill -TERM`.
- **UI:**
  - Submit with steps `99` through the browser. `form-error` should show `steps`, and no job should be created.
  - Submit a valid job. The list should update status and progress live without a reload.

## Risks
- **Browser validation blocking the API:** native constraint validation would stop the submit and leave `form-error` empty. Use `novalidate` and no `min`/`max`/`required`.
- **Lock contention:** two processes on one DB can hit `SQLITE_BUSY`. Keep `busy_timeout`, keep transactions short, and use `BEGIN IMMEDIATE` for the idempotency check-then-insert.
- **Tie ordering:** `createdAt` can tie within the same millisecond. Order by `seq`, never by timestamp.
- **Retry timing:** the retry delay must fall in 250–2000 ms. With 500 ms plus a 200 ms poll it is safe; don't use exponential backoff that exceeds 2 s.
- **Field names:** use exactly `body`, `Idempotency-Key`, and the unknown key's own name in `fields`. Don't let `typeof NaN`/`Infinity` slip through; JSON can't produce them, but use `Number.isInteger` anyway.
- **UI file location:** `ui/index.html` is read relative to `dist/server.js` (`../ui`). Don't move it into `src/`.
- **Responses on every path:** every error path, including 404/405/500, must send a JSON Content-Type.
- **Worker exit:** the worker must actually exit on SIGTERM. The heartbeat `setInterval` keeps the event loop alive, so clear it and call `process.exit`.