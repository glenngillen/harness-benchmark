The job tracker is implemented in `src/` and `ui/`, and `npm run build` succeeds. Both bundled suites pass: smoke 2/2 and contract 5/5. I did not commit anything.

I followed the plan's design, which holds up. The choices below are mine, so you can redirect them:

- **Crash recovery does not count the interrupted attempt.** On restart, `running` jobs go back to `queued` with `attempts - 1`, so the interrupted attempt re-runs with the same number. The spec says `attempts` counts *started* attempts, so a strict reading would count the killed one too. Counting it would push a job past the 3-attempt cap, so I kept the plan's approach.
- **Retry delay is a fixed 500 ms**, inside the required 250 ms–2 s window.
- **The UI's form-error region is always present** (never hidden), and the browser form uses `novalidate`. I removed the plan's `required` and `maxlength` from the input so over-long input still reaches the API.

**Verified by running the built app:**
- Validation: each listed case returns 400 naming the right field, and the job count doesn't change. Extra cases (`null`, `3.5`, `[]`, `null` steps) are rejected too.
- Routing: unknown path returns 404, `DELETE /api/jobs` returns 405, and `GET /api/jobs/xyz` returns 404 `not_found`. Errors come back as JSON.
- Retries: `failAttempts` 1 completes at attempts 2, 2 completes at attempts 3, and 3 fails with `transient failure` at attempts 3.
- Idempotency: same key and payload returns 200 with the same id, a different payload returns 409, and replay still works after restarting both processes.
- Durability: `kill -9` of both processes keeps all jobs. A worker killed mid-run resumes the job and resets progress to 0.
- Health: `worker` reads `down` about 3 s after the worker stops.
- SIGTERM: both processes exit with code 0.

**Not verified:** I syntax-checked the inline UI script but did not drive the page in a browser, so the live form-error display and 1-second refresh are checked only by reading the code.

Files changed: `src/db.ts`, `src/server.ts`, `src/worker.ts`, `ui/index.html`. The fixed files and `checks/` are untouched. The untracked dotfiles at the repo root were already there and I left them alone.