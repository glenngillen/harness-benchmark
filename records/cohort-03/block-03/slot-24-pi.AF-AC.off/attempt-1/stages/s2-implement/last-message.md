The job tracker is implemented in `src/db.ts`, `src/server.ts`, `src/worker.ts`, and `ui/index.html`. The build is clean, and both `check:smoke` (2/2) and `check:contract` (5/5) pass. I did not commit.

**What I ran against a live server and worker (fresh DB in `$TMPDIR`):**
- **Create and complete:** `hello` with 3 steps returns 201, then completes with `HELLO`, attempts 1, progress 3/3.
- **Validation:** `steps:"2"`, `failAttempts:7`, unknown field, missing or whitespace input, wrong or missing Content-Type, malformed JSON, and `[]` all return 400 naming the right field. The invalid `Idempotency-Key` and `steps:99` cases also return 400 naming the field.
- **Idempotency:** same key and same payload returns 200 with the original job, a different payload returns 409, and the job count is unchanged.
- **Retries:** `failAttempts` 1 completes on attempt 2, 2 completes on attempt 3, and 3 ends `failed` with `transient failure` and attempts 3.
- **Routing:** unknown path returns 404, `DELETE /api/jobs` returns 405, and `GET /api/jobs/xyz` returns 404.
- **Health:** `worker` shows `up` while the worker runs and `down` within about 3 s of a `kill -9`.
- **Crash recovery:** a 20-step job killed mid-run returned to `running` and completed after the worker restarted, with attempts 2. Its `updatedAt` stayed stable afterwards.
- **Durability:** jobs survived `kill -9` of the server and the worker.
- **SIGTERM:** both processes exit with code 0.

**Choices I made beyond the plan:**
- A graceful shutdown mid-attempt requeues the job without undoing the attempt count. The attempt counts as started, as the spec says.
- A request body over 1 MB returns 400 with field `body`.
- Unexpected server errors return `500 internal_error`.

**Not verified:** I did not drive the browser UI itself. I confirmed that `/` serves the page with all the `data-testid` hooks and that the inline script parses, but I did not check the live polling, error display, or submit flow in a real browser.

**Note:** Early in testing, my shell's `pgrep` returned PID 1 (the sandbox's `bwrap` init) and I ran `kill` against it. I did not verify the effect; the sandbox was unaffected for the rest of the session. I then tracked child PIDs explicitly.