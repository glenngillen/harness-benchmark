The job tracker is implemented in `src/` and `ui/`, and `npm run build`, `check:smoke` (2/2) and `check:contract` (5/5) all pass. I also ran the server and worker by hand against a temp database and checked behaviour the fixed checks don't cover.

**What I verified by hand**
- Validation: whitespace-only input, numeric strings, out-of-range and non-integer numbers, unknown fields, malformed JSON, non-object bodies, a wrong or missing Content-Type, and a bad `Idempotency-Key` all return `400` and name the field.
- Routing: unknown paths return `404 not_found`; a wrong method returns `405` with an `Allow` header.
- Idempotency: same payload returns `200` with the original job; a different payload returns `409`.
- Retries: `failAttempts: 3` ends `failed` with `attempts: 3` and `"transient failure"`; `failAttempts: 2` completes on attempt 3.
- Durability: after `kill -9` on the server, jobs and statuses are still there. The worker reports `up`, and after a `kill -9` it reports `down` within 3 seconds.
- Mid-run kill: a worker killed with `kill -9` during a running attempt requeues the job on restart, and it completes on attempt 1.
- SIGTERM: both processes exit cleanly.
- UI: the inline script passes a syntax check. I did not open the page in a browser, so the DOM behaviour is unverified.

**Choices I made where the spec was open**
- **Interrupted attempts:** when a worker restarts, any job left `running` goes back to `queued` and its `attempts` count is decremented. This keeps the three-attempt limit intact, so a job killed during attempt 3 still gets its third attempt rather than a fourth. The spec doesn't say whether a crashed attempt counts, so this is a judgment call.
- **Heartbeat:** the worker writes its timestamp every second and zeroes it on graceful shutdown, so `/health` reports `down` immediately after a clean stop.
- **Field names:** a missing or wrong Content-Type, malformed JSON, and a non-object body are reported under the field `body`.
- **Retry delay:** a failed attempt waits 500 ms before it is requeued.
- **UI:** the page polls `/api/jobs` every second, and the form omits blank numeric fields so the server defaults apply.

**Files changed**
- `src/db.ts`: opens the database and creates the schema.
- `src/store.ts` (new): job row mapping and queries.
- `src/validate.ts` (new): request and header validation.
- `src/server.ts`: the HTTP API and `/`.
- `src/worker.ts`: the processing loop, retries, heartbeat and recovery.
- `ui/index.html`: the page with the required `data-testid` elements.

Fixed files and `checks/` are untouched, and no dependencies were added. I did not commit anything.

**Environment note:** port 3917 was already in use by a process I don't control, so my first manual run hit that process instead of my server. I used a free port for everything after that, and I did not interact with the other process.