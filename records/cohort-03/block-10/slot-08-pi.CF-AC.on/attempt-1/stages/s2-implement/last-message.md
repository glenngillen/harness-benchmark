The job tracker is implemented in `src/` and `ui/`. `npm run build`, `npm run check:smoke` (2/2) and `npm run check:contract` (5/5) all pass. Nothing is committed.

**What I changed**
- **`src/db.ts`**: creates the `jobs` and `worker_heartbeat` tables on open, so either process can start first. Also has prepared statements and a `BEGIN IMMEDIATE` transaction helper.
- **`src/jobs.ts`** (new): validation that collects every error, plus the public job serializer.
- **`src/server.ts`**: routing with 404/405 JSON errors, idempotent submit inside one write transaction, health from the heartbeat (up if ≤3 s old), and graceful SIGTERM/SIGINT shutdown.
- **`src/worker.ts`**: a 500 ms heartbeat, claims the oldest due queued job, 100 ms steps with per-step progress, retries with a 500 ms persisted deadline, and recovery of interrupted jobs at startup. It also shuts down cleanly.
- **`ui/index.html`**: the form and list with the required `data-testid` hooks, polling every 500 ms with one fetch in flight at a time. Output is rendered via `textContent`.

**Checks I ran beyond the suites** (scripts kept in `$TMPDIR`, not committed)
- Worker started before the server, and the reverse order.
- Validation cases: malformed JSON, wrong media type, non-object bodies, whitespace, the 1000/1001 character boundary, null, booleans, fractions, and multiple errors at once.
- Routing: unknown paths, 405s, and unknown IDs.
- Idempotency: concurrent identical keys, a conflicting payload, and omitted versus explicit defaults.
- Retries: `failAttempts` 2 completes on attempt 3, and 3 or 5 ends failed with attempts 3.
- Durability: SIGKILL of the worker mid-job, then a restart that completes the job. Health reports down after the kill.
- SIGTERM exits cleanly for both processes, and jobs persist across a restart.

**Choices I made**
- An interrupted third attempt is rewound so its replay reuses attempt 3 and does not start a fourth. Earlier interrupted attempts count as started, and the next attempt number follows.
- On clean worker shutdown the heartbeat row is deleted, so health reports down immediately.
- The `Idempotency-Key` header is joined if it is repeated, so a duplicate fails the key pattern rather than one value being picked.

**Not verified**
- **The browser page was not exercised.** No headless browser is installed. I checked the required `data-testid` hooks in the markup, and the page is served by the server, but the polling and rendering are untested.

**Environment notes**
- Port 3917 is held by a process I can't see and did not start, so I ran my tests on port 4817. I didn't touch the other process.
- My first aborted run left a worker process polling a database under `$TMPDIR/jt`. I couldn't find it to stop it. It is harmless, but it is still running.