Addressed both findings:

- Interrupted jobs are requeued as a replacement attempt, so a third attempt interrupted before completion can finish without being marked as a transient failure. I verified the reported scenario completes with `attempts: 3`.
- Added `novalidate` so fractional numeric values reach API validation and appear in the form error region.

The build passes and the worker starts. Server startup and the network checks remain blocked by this environment’s `listen EPERM` restriction. `git diff --check` passes.