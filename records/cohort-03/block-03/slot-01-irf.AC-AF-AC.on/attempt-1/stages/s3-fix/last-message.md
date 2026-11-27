All three findings were correct, and I fixed each one. The build succeeds, both check suites pass (smoke 2/2, contract 5/5), and I checked the fixes at runtime.

- **Finding 1 (attempts above 3 after an interruption):** Fixed. Startup recovery now sets `attempts = MAX(attempts - 1, 0)` for jobs left `running`, so the rerun reuses the interrupted attempt's number. A graceful `SIGTERM` leaves the job `running`, so it gets the same treatment on the next start. As a guard, `claimNext` now marks a queued job that already has 3 attempts as `failed` with `transient failure` instead of running it. A test that SIGKILLed the worker during a 20-step job with `failAttempts: 2` finished with `attempts: 3` and `completed`.
- **Finding 2 (malformed percent-encoded id returns 500):** Fixed. The decode is wrapped in try/catch and returns `404 not_found`. Verified: `GET /api/jobs/%E0%A4%A` now returns 404.
- **Finding 3 (worker crashes on a DB error):** Fixed. `beat()` catches and logs its errors. The main loop catches errors per iteration, logs them, sleeps `POLL_MS`, and continues. Startup recovery is also wrapped so a failure there is logged rather than fatal.

I did not commit these changes.