The job tracker is implemented in `src/` and `ui/`, and it builds. Both fixed check suites pass (smoke 2/2, contract 5/5). I also ran the remaining plan behaviours by hand against a live server and worker, and they match the spec. Nothing is committed.

**What I changed**
- **`src/db.ts`**: schema migration, the `Job` row-to-JSON mapping, and heartbeat helpers. `openDatabase` now creates the schema, so either process can start first.
- **`src/server.ts`**: a `node:http` router with the strict validation, transactional idempotency (`BEGIN IMMEDIATE` plus a UNIQUE key), `/health` based on the worker heartbeat, the `/` UI route, JSON errors with the right status codes, and SIGTERM handling.
- **`src/worker.ts`**: a heartbeat every second, recovery of `running` jobs on startup, an atomic claim loop, progress written after each 100 ms step, retries through `run_after`, and clean SIGTERM shutdown.
- **`ui/index.html`**: the form, the `form-error` alert, and a list polled every second. Existing items are reused and reordered.

**Verified by hand**
- Validation: every case in the plan returns 400 with the right field, and no job is created.
- Routes: 405 and 404 are returned with JSON bodies, and 405 includes an `Allow` header.
- Idempotency: replay returns 200, a different payload returns 409, and the same key still replays after a restart.
- Progress: a `steps:10` job climbs 1/10 to 10/10 and ends `HI`.
- Retries: `failAttempts` 1 gives `attempts` 2, 2 gives 3, and 3 ends `failed` with `"transient failure"`.
- Crash recovery: `kill -9` on the worker mid-job, then a restart, completes the job with `attempts` 1. A full SIGKILL of both processes keeps the data, and completed jobs are not rerun.
- Health: `worker` is `up` while the worker runs and `down` about 3 s after it is killed.
- Shutdown: SIGTERM exits with code 0 in under 110 ms for both processes.

**Choices and deviations**
- The input is an `<input type="text">`, not the plan's textarea, since the task calls it a text field. Both the form and the API use `novalidate`, and I removed a `maxlength` attribute so the API gets to do the rejecting.
- Retries wait 500 ms, which is inside the 250 ms–2 s window.
- Request bodies over 64 KiB get a 400 `body` error.
- Heartbeat and worker loop errors are logged and do not crash the process.

**Not verified**
- I did not test the page in a real browser, since there is none here. The `data-testid` attributes are present in the served HTML, and the rendering and polling code is untested in a browser.
- The hidden evaluation may check things beyond the disclosed examples.